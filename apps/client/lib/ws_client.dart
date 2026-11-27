import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'daemon_health.dart';
import 'ws_protocol.dart';

typedef WebSocketChannelFactory = WebSocketChannel Function(Uri uri);

enum ThreadConnectionStatus {
  connecting('Connecting'),
  connected('Connected'),
  error('Error'),
  disconnected('Disconnected');

  const ThreadConnectionStatus(this.label);
  final String label;
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
  }) : _channelFactory = channelFactory ?? WebSocketChannel.connect,
       _requestIdGenerator = requestIdGenerator ?? _defaultRequestIdGenerator;

  final Uri daemonBaseUri;
  final WebSocketChannelFactory _channelFactory;
  final String Function() _requestIdGenerator;

  WebSocketChannel? _channel;
  StreamSubscription<Object?>? _subscription;
  bool _disposed = false;

  ThreadConnectionStatus _status = ThreadConnectionStatus.disconnected;
  ThreadSnapshot? _thread;
  int? _lastSeq;
  String? _errorMessage;
  String? _pendingRequestId;

  ThreadConnectionStatus get status => _status;
  ThreadSnapshot? get thread => _thread;
  int? get lastSeq => _lastSeq;
  String? get errorMessage => _errorMessage;
  String? get pendingRequestId => _pendingRequestId;

  void connect() {
    if (_disposed) {
      return;
    }
    unawaited(_closeCurrentChannel());

    _status = ThreadConnectionStatus.connecting;
    _errorMessage = null;
    notifyListeners();

    final WebSocketChannel channel;
    try {
      channel = _channelFactory(deriveWebSocketUri(daemonBaseUri));
    } catch (error) {
      _status = ThreadConnectionStatus.error;
      _errorMessage = error.toString();
      notifyListeners();
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
      _status = ThreadConnectionStatus.error;
      _errorMessage = error.toString();
      notifyListeners();
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
        if (message.protocolVersion != kExpectedProtocolVersion) {
          _status = ThreadConnectionStatus.error;
          _errorMessage =
              'Incompatible protocol v${message.protocolVersion} (expected v$kExpectedProtocolVersion).';
          unawaited(_closeCurrentChannel());
          notifyListeners();
          return;
        }
        _thread = message.thread;
        _lastSeq = message.seq;
        _status = ThreadConnectionStatus.connected;
        _errorMessage = null;
        notifyListeners();
      case DaemonAckMessage():
        if (_pendingRequestId == message.requestId) {
          _pendingRequestId = null;
          notifyListeners();
        }
      case DaemonErrorMessage():
        _errorMessage = _formatDaemonError(message);
        if (_status != ThreadConnectionStatus.connected ||
            message.code == ProtocolErrorCode.unsupportedProtocolVersion ||
            message.code == ProtocolErrorCode.handshakeRequired) {
          _status = ThreadConnectionStatus.error;
        }
        if (message.requestId != null &&
            _pendingRequestId == message.requestId) {
          _pendingRequestId = null;
        }
        notifyListeners();
    }
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
    if (_disposed || _channel != channel) {
      return;
    }
    _status = ThreadConnectionStatus.error;
    _errorMessage = error.toString();
    notifyListeners();
  }

  void _handleStreamDone(WebSocketChannel channel) {
    if (_disposed || _channel != channel) {
      return;
    }
    _channel = null;
    _subscription = null;
    if (_status != ThreadConnectionStatus.error) {
      _status = ThreadConnectionStatus.disconnected;
    }
    notifyListeners();
  }

  /// Sends an Owner prompt on the active Thread with a unique `requestId`.
  void submitPrompt(String text) {
    final WebSocketChannel? channel = _channel;
    if (_disposed ||
        channel == null ||
        _status != ThreadConnectionStatus.connected ||
        text.trim().isEmpty) {
      return;
    }
    final String requestId = _requestIdGenerator();
    final String threadId = _thread?.id ?? kDefaultMainThreadId;
    final ClientSubmitMessage submit = ClientSubmitMessage(
      threadId: threadId,
      requestId: requestId,
      text: text,
    );
    _pendingRequestId = requestId;
    channel.sink.add(jsonEncode(submit.toJson()));
    notifyListeners();
  }

  Future<void> _closeCurrentChannel() async {
    final StreamSubscription<Object?>? sub = _subscription;
    final WebSocketChannel? channel = _channel;
    _subscription = null;
    _channel = null;
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
    unawaited(_closeCurrentChannel());
    super.dispose();
  }
}
