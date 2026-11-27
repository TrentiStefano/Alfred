import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'daemon_health.dart';
import 'ws_protocol.dart';

typedef WebSocketChannelFactory = WebSocketChannel Function(Uri uri);
typedef ReconnectDelayBuilder = Duration Function(int attempt);

enum ThreadConnectionStatus {
  connecting('Connecting'),
  connected('Connected'),
  streaming('Streaming'),
  reconnecting('Reconnecting'),
  offline('Offline'),
  error('Error');

  const ThreadConnectionStatus(this.label);
  final String label;
}

class PendingSubmission {
  const PendingSubmission({
    required this.threadId,
    required this.requestId,
    required this.text,
  });

  final String threadId;
  final String requestId;
  final String text;
}

Duration _defaultReconnectDelay(int attempt) {
  final int shift = (attempt - 1).clamp(0, 5);
  return Duration(milliseconds: 500 * (1 << shift));
}

/// Converts an HTTP(S) or WS(S) daemon base URI into its `/ws` endpoint URI.
Uri deriveWebSocketUri(Uri daemonBaseUri) {
  final String wsScheme = switch (daemonBaseUri.scheme) {
    'http' => 'ws',
    'https' => 'wss',
    'ws' => 'ws',
    'wss' => 'wss',
    _ => throw ArgumentError.value(
      daemonBaseUri,
      'daemonBaseUri',
      'Unsupported daemon URI scheme "${daemonBaseUri.scheme}".',
    ),
  };
  return daemonBaseUri.resolve('/ws').replace(scheme: wsScheme);
}

String _defaultRequestIdGenerator() {
  return 'req-${DateTime.now().microsecondsSinceEpoch}';
}

/// Client boundary managing the daemon WebSocket handshake and Thread state.
class AlfredWsClient extends ChangeNotifier {
  AlfredWsClient({
    required this.daemonBaseUri,
    WebSocketChannelFactory? channelFactory,
    String Function()? requestIdGenerator,
    ReconnectDelayBuilder? reconnectDelay,
    this.maxReconnectAttempts = 5,
  }) : _channelFactory = channelFactory ?? WebSocketChannel.connect,
       _requestIdGenerator = requestIdGenerator ?? _defaultRequestIdGenerator,
       _reconnectDelay = reconnectDelay ?? _defaultReconnectDelay;

  final Uri daemonBaseUri;
  final WebSocketChannelFactory _channelFactory;
  final String Function() _requestIdGenerator;
  final ReconnectDelayBuilder _reconnectDelay;
  final int maxReconnectAttempts;

  WebSocketChannel? _channel;
  StreamSubscription<Object?>? _subscription;
  Timer? _reconnectTimer;
  bool _disposed = false;
  bool _handshaked = false;
  bool _allowAutoReconnect = true;
  bool _fatalProtocolError = false;
  int _reconnectAttempt = 0;

  ThreadConnectionStatus _status = ThreadConnectionStatus.offline;
  ThreadSnapshot? _thread;
  int? _lastSeq;
  String? _errorMessage;
  PendingSubmission? _pendingSubmission;

  ThreadConnectionStatus get status => _status;
  ThreadSnapshot? get thread => _thread;
  int? get lastSeq => _lastSeq;
  String? get errorMessage => _errorMessage;
  String? get pendingRequestId => _pendingSubmission?.requestId;
  bool get canSubmit =>
      !_disposed &&
      _channel != null &&
      _handshaked &&
      !_fatalProtocolError &&
      (_status == ThreadConnectionStatus.connected ||
          _status == ThreadConnectionStatus.error);

  void connect() {
    if (_disposed) {
      return;
    }
    _cancelReconnectTimer();
    _reconnectAttempt = 0;
    _allowAutoReconnect = true;
    _fatalProtocolError = false;
    _openChannel(ThreadConnectionStatus.connecting);
  }

  void _openChannel(ThreadConnectionStatus initialStatus) {
    if (_disposed) {
      return;
    }
    unawaited(_closeCurrentChannel());

    _handshaked = false;
    _status = initialStatus;
    if (initialStatus == ThreadConnectionStatus.connecting) {
      _errorMessage = null;
    }
    notifyListeners();

    final WebSocketChannel channel;
    try {
      channel = _channelFactory(deriveWebSocketUri(daemonBaseUri));
    } catch (error) {
      _scheduleReconnect(errorMessage: error.toString());
      return;
    }

    _channel = channel;
    _subscription = channel.stream.listen(
      (Object? data) => _handleIncoming(channel, data),
      onError: (Object error) => _handleStreamError(channel, error),
      onDone: () => _handleStreamDone(channel),
    );

    unawaited(_sendHelloWhenReady(channel));
  }

  Future<void> _sendHelloWhenReady(WebSocketChannel channel) async {
    try {
      await channel.ready;
      if (_disposed || _channel != channel) {
        return;
      }
      const ClientHelloMessage hello = ClientHelloMessage(
        protocolVersion: kExpectedProtocolVersion,
        client: HelloClientInfo(
          name: 'alfred-client',
          version: '1.0.0',
          platform: 'flutter',
        ),
      );
      channel.sink.add(jsonEncode(hello.toJson()));
    } catch (error) {
      if (_disposed || _channel != channel) {
        return;
      }
      _onChannelLost(channel, errorMessage: error.toString());
    }
  }

  void _handleIncoming(WebSocketChannel channel, Object? raw) {
    if (_disposed || _channel != channel) {
      return;
    }

    final DaemonMessage message;
    try {
      final String text = switch (raw) {
        String s => s,
        List<int> bytes => utf8.decode(bytes),
        _ => throw FormatException(
          'Unexpected WebSocket frame type ${raw.runtimeType}.',
        ),
      };
      message = DaemonMessage.fromJsonObject(jsonDecode(text));
    } catch (error) {
      _status = ThreadConnectionStatus.error;
      _errorMessage = error.toString();
      notifyListeners();
      return;
    }

    switch (message) {
      case DaemonSnapshotMessage():
        _handleSnapshot(channel, message);
      case DaemonDeltaMessage():
        _handleDelta(channel, message);
      case DaemonAckMessage():
        if (_pendingSubmission?.requestId == message.requestId) {
          _pendingSubmission = null;
          notifyListeners();
        }
      case DaemonErrorMessage():
        _handleDaemonError(message);
    }
  }

  void _handleSnapshot(
    WebSocketChannel channel,
    DaemonSnapshotMessage message,
  ) {
    if (message.protocolVersion != kExpectedProtocolVersion) {
      _fatalProtocolError = true;
      _allowAutoReconnect = false;
      _cancelReconnectTimer();
      _status = ThreadConnectionStatus.error;
      _errorMessage =
          'Incompatible protocol v${message.protocolVersion} (expected v$kExpectedProtocolVersion).';
      unawaited(_closeCurrentChannel());
      notifyListeners();
      return;
    }

    _handshaked = true;
    _reconnectAttempt = 0;
    _thread = message.thread;
    _lastSeq = message.seq;
    _errorMessage = null;
    _status = switch (message.thread.status) {
      ThreadStatus.idle => ThreadConnectionStatus.connected,
      ThreadStatus.streaming => ThreadConnectionStatus.streaming,
      ThreadStatus.error => ThreadConnectionStatus.error,
    };

    final PendingSubmission? pending = _pendingSubmission;
    if (pending != null && pending.threadId == message.thread.id) {
      final bool alreadyPersisted = message.thread.messages.any(
        (ThreadMessage msg) => msg.requestId == pending.requestId,
      );
      if (alreadyPersisted) {
        _pendingSubmission = null;
      } else {
        final ClientSubmitMessage retrySubmit = ClientSubmitMessage(
          threadId: pending.threadId,
          requestId: pending.requestId,
          text: pending.text,
        );
        channel.sink.add(jsonEncode(retrySubmit.toJson()));
      }
    }

    notifyListeners();
  }

  void _handleDelta(WebSocketChannel channel, DaemonDeltaMessage message) {
    if (message.protocolVersion != kExpectedProtocolVersion) {
      _fatalProtocolError = true;
      _allowAutoReconnect = false;
      _cancelReconnectTimer();
      _status = ThreadConnectionStatus.error;
      _errorMessage =
          'Incompatible protocol v${message.protocolVersion} (expected v$kExpectedProtocolVersion).';
      unawaited(_closeCurrentChannel());
      notifyListeners();
      return;
    }

    final ThreadSnapshot? currentThread = _thread;
    if (currentThread != null && message.threadId != currentThread.id) {
      return;
    }

    final int? lastSeq = _lastSeq;
    if (lastSeq != null && message.seq <= lastSeq) {
      return;
    }
    if (lastSeq != null && message.seq > lastSeq + 1) {
      _triggerResyncReconnect();
      return;
    }

    _lastSeq = message.seq;
    final List<ThreadMessage> messages = List<ThreadMessage>.of(
      currentThread?.messages ?? const <ThreadMessage>[],
    );
    ThreadConnectionStatus nextStatus = _status;

    switch (message.event) {
      case DeltaTurnStartEvent(:final String messageId):
        final DeltaTurnStartEvent start = message.event as DeltaTurnStartEvent;
        if (start.requestId != null &&
            _pendingSubmission?.requestId == start.requestId) {
          _pendingSubmission = null;
        }
        final int existingIndex = messages.indexWhere(
          (ThreadMessage m) => m.id == messageId,
        );
        final ThreadMessage created = ThreadMessage(
          id: messageId,
          role: start.role,
          text: start.text ?? '',
          status: ThreadMessageStatus.streaming,
          requestId: start.requestId,
          createdAt: start.createdAt,
        );
        if (existingIndex >= 0) {
          messages[existingIndex] = created;
        } else {
          messages.add(created);
        }
        if (start.role == ThreadMessageRole.agent) {
          nextStatus = ThreadConnectionStatus.streaming;
          _errorMessage = null;
        }
      case DeltaTextDeltaEvent(:final String messageId, :final String delta):
        final int index = messages.indexWhere(
          (ThreadMessage m) => m.id == messageId,
        );
        if (index >= 0) {
          final ThreadMessage existing = messages[index];
          messages[index] = ThreadMessage(
            id: existing.id,
            role: existing.role,
            text: '${existing.text}$delta',
            status: ThreadMessageStatus.streaming,
            requestId: existing.requestId,
            createdAt: existing.createdAt,
          );
        } else {
          messages.add(
            ThreadMessage(
              id: messageId,
              role: ThreadMessageRole.agent,
              text: delta,
              status: ThreadMessageStatus.streaming,
              createdAt: DateTime.now().toUtc().toIso8601String(),
            ),
          );
        }
        nextStatus = ThreadConnectionStatus.streaming;
      case DeltaTurnFinishEvent(:final String messageId):
        final int index = messages.indexWhere(
          (ThreadMessage m) => m.id == messageId,
        );
        ThreadMessageRole? finishedRole;
        if (index >= 0) {
          final ThreadMessage existing = messages[index];
          finishedRole = existing.role;
          messages[index] = ThreadMessage(
            id: existing.id,
            role: existing.role,
            text: existing.text,
            status: ThreadMessageStatus.complete,
            requestId: existing.requestId,
            createdAt: existing.createdAt,
          );
        }
        final bool anyAgentStreaming = messages.any(
          (ThreadMessage m) =>
              m.role == ThreadMessageRole.agent &&
              m.status == ThreadMessageStatus.streaming,
        );
        if (!anyAgentStreaming &&
            (finishedRole == ThreadMessageRole.agent ||
                _status == ThreadConnectionStatus.streaming)) {
          nextStatus = ThreadConnectionStatus.connected;
          _errorMessage = null;
        }
      case DeltaTurnErrorEvent(
        :final String messageId,
        :final ThreadMessageStatus status,
        :final String message,
      ):
        final int index = messages.indexWhere(
          (ThreadMessage m) => m.id == messageId,
        );
        if (index >= 0) {
          final ThreadMessage existing = messages[index];
          messages[index] = ThreadMessage(
            id: existing.id,
            role: existing.role,
            text: existing.text.isEmpty ? message : existing.text,
            status: status,
            requestId: existing.requestId,
            createdAt: existing.createdAt,
          );
        } else {
          messages.add(
            ThreadMessage(
              id: messageId,
              role: ThreadMessageRole.agent,
              text: message,
              status: status,
              createdAt: DateTime.now().toUtc().toIso8601String(),
            ),
          );
        }
        nextStatus = ThreadConnectionStatus.error;
    }

    _status = nextStatus;
    _thread = ThreadSnapshot(
      id: currentThread?.id ?? message.threadId,
      agentName: currentThread?.agentName ?? kDefaultMainAgentName,
      status: switch (nextStatus) {
        ThreadConnectionStatus.streaming => ThreadStatus.streaming,
        ThreadConnectionStatus.error => ThreadStatus.error,
        _ => ThreadStatus.idle,
      },
      messages: List<ThreadMessage>.unmodifiable(messages),
    );
    notifyListeners();
  }

  void _handleDaemonError(DaemonErrorMessage message) {
    _errorMessage = _formatDaemonError(message);
    if (message.code == ProtocolErrorCode.unsupportedProtocolVersion) {
      _fatalProtocolError = true;
      _allowAutoReconnect = false;
      _cancelReconnectTimer();
      _status = ThreadConnectionStatus.error;
      unawaited(_closeCurrentChannel());
    } else if (!_handshaked ||
        message.code == ProtocolErrorCode.handshakeRequired) {
      _status = ThreadConnectionStatus.error;
    }
    if (message.requestId != null &&
        _pendingSubmission?.requestId == message.requestId) {
      _pendingSubmission = null;
    }
    notifyListeners();
  }

  String _formatDaemonError(DaemonErrorMessage error) {
    if (error.code == ProtocolErrorCode.unsupportedProtocolVersion) {
      final int expected =
          error.expectedProtocolVersion ?? kExpectedProtocolVersion;
      return '${error.message} (expected v$expected)';
    }
    return error.message;
  }

  void _handleStreamError(WebSocketChannel channel, Object error) {
    _onChannelLost(channel, errorMessage: error.toString());
  }

  void _handleStreamDone(WebSocketChannel channel) {
    _onChannelLost(channel);
  }

  void _onChannelLost(WebSocketChannel channel, {String? errorMessage}) {
    if (_disposed || _channel != channel) {
      return;
    }
    final StreamSubscription<Object?>? sub = _subscription;
    _channel = null;
    _subscription = null;
    _handshaked = false;
    if (sub != null) {
      unawaited(sub.cancel());
    }

    if (_fatalProtocolError) {
      _status = ThreadConnectionStatus.error;
      if (errorMessage != null && _errorMessage == null) {
        _errorMessage = errorMessage;
      }
      notifyListeners();
      return;
    }

    if (!_allowAutoReconnect) {
      _status = ThreadConnectionStatus.offline;
      notifyListeners();
      return;
    }

    _scheduleReconnect(errorMessage: errorMessage);
  }

  void _scheduleReconnect({String? errorMessage}) {
    if (_disposed || !_allowAutoReconnect || _fatalProtocolError) {
      return;
    }
    _cancelReconnectTimer();
    _reconnectAttempt += 1;
    if (_reconnectAttempt > maxReconnectAttempts) {
      _status = ThreadConnectionStatus.offline;
      if (errorMessage != null) {
        _errorMessage = errorMessage;
      }
      notifyListeners();
      return;
    }

    _status = ThreadConnectionStatus.reconnecting;
    if (errorMessage != null) {
      _errorMessage = errorMessage;
    }
    notifyListeners();

    final Duration delay = _reconnectDelay(_reconnectAttempt);
    _reconnectTimer = Timer(delay, () {
      _reconnectTimer = null;
      if (_disposed || !_allowAutoReconnect || _fatalProtocolError) {
        return;
      }
      _openChannel(ThreadConnectionStatus.reconnecting);
    });
  }

  void _triggerResyncReconnect() {
    if (_disposed || !_allowAutoReconnect || _fatalProtocolError) {
      return;
    }
    _cancelReconnectTimer();
    _reconnectAttempt = 0;
    _openChannel(ThreadConnectionStatus.reconnecting);
  }

  /// Sends an Owner prompt on the active Thread with a unique `requestId`.
  void submitPrompt(String text) {
    final WebSocketChannel? channel = _channel;
    if (!canSubmit || channel == null || text.trim().isEmpty) {
      return;
    }
    final String requestId = _requestIdGenerator();
    final String threadId = _thread?.id ?? kDefaultMainThreadId;
    final ClientSubmitMessage submit = ClientSubmitMessage(
      threadId: threadId,
      requestId: requestId,
      text: text,
    );
    _pendingSubmission = PendingSubmission(
      threadId: threadId,
      requestId: requestId,
      text: text,
    );
    channel.sink.add(jsonEncode(submit.toJson()));
    notifyListeners();
  }

  void _cancelReconnectTimer() {
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
  }

  Future<void> _closeCurrentChannel() async {
    final StreamSubscription<Object?>? sub = _subscription;
    final WebSocketChannel? channel = _channel;
    _subscription = null;
    _channel = null;
    _handshaked = false;
    if (sub != null) {
      await sub.cancel();
    }
    if (channel != null) {
      await channel.sink.close();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _allowAutoReconnect = false;
    _cancelReconnectTimer();
    unawaited(_closeCurrentChannel());
    super.dispose();
  }
}
