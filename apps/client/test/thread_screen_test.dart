import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:alfred_client/app.dart';
import 'package:alfred_client/ws_client.dart';
import 'package:alfred_client/ws_protocol.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:stream_channel/stream_channel.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

class _FakeWebSocketSink implements WebSocketSink {
  _FakeWebSocketSink(this._inner, this._onClose);

  final StreamSink<Object?> _inner;
  final void Function(int? closeCode, String? closeReason) _onClose;

  @override
  void add(Object? data) {
    _inner.add(data);
  }

  @override
  void addError(Object error, [StackTrace? stackTrace]) {
    _inner.addError(error, stackTrace);
  }

  @override
  Future<void> addStream(Stream<Object?> stream) {
    return _inner.addStream(stream);
  }

  @override
  Future<void> close([int? closeCode, String? closeReason]) {
    _onClose(closeCode, closeReason);
    return _inner.close();
  }

  @override
  Future<void> get done => _inner.done;
}

class _FakeWebSocketChannel extends StreamChannelMixin<Object?>
    implements WebSocketChannel {
  _FakeWebSocketChannel({Completer<void>? readyCompleter})
    : _controller = StreamChannelController<Object?>(sync: true),
      _readyCompleter = readyCompleter ?? (Completer<void>()..complete()) {
    _sink = _FakeWebSocketSink(_controller.foreign.sink, (
      int? closeCode,
      String? closeReason,
    ) {
      _closeCode = closeCode;
      _closeReason = closeReason;
    });
    _localSubscription = _controller.local.stream.listen((Object? raw) {
      final ClientMessage msg = ClientMessage.fromJsonObject(
        jsonDecode(raw! as String),
      );
      if (_waiters.isNotEmpty) {
        _waiters.removeAt(0).complete(msg);
      } else {
        _inbox.add(msg);
      }
    });
  }

  final StreamChannelController<Object?> _controller;
  final Completer<void> _readyCompleter;
  late final _FakeWebSocketSink _sink;
  late final StreamSubscription<Object?> _localSubscription;
  final List<ClientMessage> _inbox = <ClientMessage>[];
  final List<Completer<ClientMessage>> _waiters = <Completer<ClientMessage>>[];
  int? _closeCode;
  String? _closeReason;

  Future<ClientMessage> nextClientMessage() {
    if (_inbox.isNotEmpty) {
      return Future<ClientMessage>.value(_inbox.removeAt(0));
    }
    final Completer<ClientMessage> completer = Completer<ClientMessage>();
    _waiters.add(completer);
    return completer.future;
  }

  void sendFromServer(DaemonMessage message) {
    _controller.local.sink.add(jsonEncode(message.toJson()));
  }

  void closeFromServer([int? closeCode, String? closeReason]) {
    _closeCode = closeCode;
    _closeReason = closeReason;
    unawaited(_localSubscription.cancel());
    unawaited(_controller.local.sink.close());
  }

  @override
  Stream<Object?> get stream => _controller.foreign.stream;

  @override
  WebSocketSink get sink => _sink;

  @override
  Future<void> get ready => _readyCompleter.future;

  @override
  String? get protocol => null;

  @override
  int? get closeCode => _closeCode;

  @override
  String? get closeReason => _closeReason;
}

void main() {
  test('deriveWebSocketUri maps http/https base URIs to /ws', () {
    expect(
      deriveWebSocketUri(Uri.parse('http://127.0.0.1:4040')),
      Uri.parse('ws://127.0.0.1:4040/ws'),
    );
    expect(
      deriveWebSocketUri(Uri.parse('https://alfred.example:8443')),
      Uri.parse('wss://alfred.example:8443/ws'),
    );
  });

  testWidgets(
    'performs hello -> snapshot handshake, renders Thread, and submits prompt with requestId',
    (WidgetTester tester) async {
      final List<Uri> connectedUris = <Uri>[];
      late _FakeWebSocketChannel fakeChannel;
      final Completer<void> readyCompleter = Completer<void>();
      int requestCounter = 0;

      await tester.pumpWidget(
        AlfredApp(
          daemonBaseUri: Uri.parse('http://127.0.0.1:4040'),
          webSocketChannelFactory: (Uri uri) {
            connectedUris.add(uri);
            fakeChannel = _FakeWebSocketChannel(readyCompleter: readyCompleter);
            return fakeChannel;
          },
          requestIdGenerator: () {
            requestCounter += 1;
            return 'req-test-$requestCounter';
          },
        ),
      );
      await tester.pump();

      expect(connectedUris, <Uri>[Uri.parse('ws://127.0.0.1:4040/ws')]);
      expect(find.text('Connecting'), findsOneWidget);

      readyCompleter.complete();
      await tester.pump();

      final ClientMessage hello = await fakeChannel.nextClientMessage();
      expect(hello, isA<ClientHelloMessage>());
      expect((hello as ClientHelloMessage).protocolVersion, 1);

      fakeChannel.sendFromServer(
        const DaemonSnapshotMessage(
          protocolVersion: 1,
          seq: 0,
          thread: ThreadSnapshot(
            id: kDefaultMainThreadId,
            agentName: kDefaultMainAgentName,
            status: ThreadStatus.idle,
            messages: <ThreadMessage>[
              ThreadMessage(
                id: 'msg-0',
                role: ThreadMessageRole.agent,
                text: 'Welcome back.',
                status: ThreadMessageStatus.complete,
                createdAt: '2026-11-27T12:00:00.000Z',
              ),
            ],
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Connected'), findsOneWidget);
      expect(find.text('Welcome back.'), findsOneWidget);

      // Type and submit a prompt
      await tester.enterText(find.byType(TextField), 'Check my inbox');
      await tester.pump();
      await tester.tap(find.widgetWithText(FilledButton, 'Send'));
      await tester.pump();

      final ClientMessage submitted = await fakeChannel.nextClientMessage();
      expect(submitted, isA<ClientSubmitMessage>());
      final ClientSubmitMessage submitMsg = submitted as ClientSubmitMessage;
      expect(submitMsg.threadId, kDefaultMainThreadId);
      expect(submitMsg.requestId, 'req-test-1');
      expect(submitMsg.text, 'Check my inbox');

      fakeChannel.sendFromServer(
        const DaemonAckMessage(
          threadId: kDefaultMainThreadId,
          requestId: 'req-test-1',
          submissionId: 'sub-1',
          deduplicated: false,
        ),
      );
      fakeChannel.sendFromServer(
        const DaemonSnapshotMessage(
          protocolVersion: 1,
          seq: 1,
          thread: ThreadSnapshot(
            id: kDefaultMainThreadId,
            agentName: kDefaultMainAgentName,
            status: ThreadStatus.idle,
            messages: <ThreadMessage>[
              ThreadMessage(
                id: 'msg-0',
                role: ThreadMessageRole.agent,
                text: 'Welcome back.',
                status: ThreadMessageStatus.complete,
                createdAt: '2026-11-27T12:00:00.000Z',
              ),
              ThreadMessage(
                id: 'msg-1',
                role: ThreadMessageRole.owner,
                text: 'Check my inbox',
                status: ThreadMessageStatus.complete,
                requestId: 'req-test-1',
                createdAt: '2026-11-27T12:00:01.000Z',
              ),
              ThreadMessage(
                id: 'msg-2',
                role: ThreadMessageRole.agent,
                text: 'Stub Alfred received: Check my inbox',
                status: ThreadMessageStatus.complete,
                createdAt: '2026-11-27T12:00:01.000Z',
              ),
            ],
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Check my inbox'), findsOneWidget);
      expect(find.text('Stub Alfred received: Check my inbox'), findsOneWidget);

      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets(
    'surfaces clear version-mismatch error when hello is rejected and does not auto-reconnect',
    (WidgetTester tester) async {
      final List<_FakeWebSocketChannel> channels = <_FakeWebSocketChannel>[];

      await tester.pumpWidget(
        AlfredApp(
          daemonBaseUri: Uri.parse('http://127.0.0.1:4040'),
          webSocketChannelFactory: (Uri _) {
            final _FakeWebSocketChannel channel = _FakeWebSocketChannel();
            channels.add(channel);
            return channel;
          },
          reconnectDelay: (_) => Duration.zero,
          maxReconnectAttempts: 3,
        ),
      );
      await tester.pump();

      channels.first.sendFromServer(
        const DaemonErrorMessage(
          code: ProtocolErrorCode.unsupportedProtocolVersion,
          message: 'Unsupported protocol version 1; expected 2.',
          protocolVersion: 1,
          expectedProtocolVersion: 2,
        ),
      );
      channels.first.closeFromServer(1008, 'unsupported_protocol_version');
      await tester.pumpAndSettle();

      expect(channels, hasLength(1));
      expect(find.text('Error'), findsOneWidget);
      expect(
        find.textContaining('Unsupported protocol version'),
        findsOneWidget,
      );
      expect(find.textContaining('v2'), findsOneWidget);
    },
  );

  testWidgets(
    'shows Reconnecting then Disconnected when reconnect attempts exhaust and reconnects on tap',
    (WidgetTester tester) async {
      final List<_FakeWebSocketChannel> channels = <_FakeWebSocketChannel>[];

      await tester.pumpWidget(
        AlfredApp(
          daemonBaseUri: Uri.parse('http://127.0.0.1:4040'),
          webSocketChannelFactory: (Uri _) {
            final _FakeWebSocketChannel channel = _FakeWebSocketChannel();
            channels.add(channel);
            return channel;
          },
          reconnectDelay: (_) => const Duration(milliseconds: 20),
          maxReconnectAttempts: 1,
        ),
      );
      await tester.pump();

      channels.first.sendFromServer(
        const DaemonSnapshotMessage(
          protocolVersion: 1,
          seq: 0,
          thread: ThreadSnapshot(
            id: kDefaultMainThreadId,
            agentName: kDefaultMainAgentName,
            status: ThreadStatus.idle,
            messages: <ThreadMessage>[],
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Connected'), findsOneWidget);

      // Unexpected close triggers Reconnecting while backing off.
      channels.first.closeFromServer(1001, 'server_shutdown');
      await tester.pump();
      expect(find.text('Reconnecting'), findsOneWidget);

      // Backoff timer fires and opens attempt #2.
      await tester.pump(const Duration(milliseconds: 25));
      expect(channels, hasLength(2));

      // Attempt #2 also drops before handshake; attempts exhausted -> Disconnected.
      channels[1].closeFromServer(1006, 'connection_lost');
      await tester.pump();
      expect(find.text('Disconnected'), findsOneWidget);
      expect(find.widgetWithText(OutlinedButton, 'Reconnect'), findsOneWidget);

      // Manual Reconnect button opens attempt #3 and recovers.
      await tester.tap(find.widgetWithText(OutlinedButton, 'Reconnect'));
      await tester.pump();
      expect(channels, hasLength(3));

      channels.last.sendFromServer(
        const DaemonSnapshotMessage(
          protocolVersion: 1,
          seq: 0,
          thread: ThreadSnapshot(
            id: kDefaultMainThreadId,
            agentName: kDefaultMainAgentName,
            status: ThreadStatus.idle,
            messages: <ThreadMessage>[],
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Connected'), findsOneWidget);

      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets(
    'streams incremental deltas live (Streaming -> Connected) and handles turn_error recovery',
    (WidgetTester tester) async {
      late _FakeWebSocketChannel fakeChannel;

      await tester.pumpWidget(
        AlfredApp(
          daemonBaseUri: Uri.parse('http://127.0.0.1:4040'),
          webSocketChannelFactory: (Uri _) {
            fakeChannel = _FakeWebSocketChannel();
            return fakeChannel;
          },
          requestIdGenerator: () => 'req-stream-ui-1',
        ),
      );
      await tester.pump();
      await fakeChannel.nextClientMessage(); // hello

      fakeChannel.sendFromServer(
        const DaemonSnapshotMessage(
          protocolVersion: 1,
          seq: 0,
          thread: ThreadSnapshot(
            id: kDefaultMainThreadId,
            agentName: kDefaultMainAgentName,
            status: ThreadStatus.idle,
            messages: <ThreadMessage>[],
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Connected'), findsOneWidget);

      await tester.enterText(find.byType(TextField), 'Hello');
      await tester.pump();
      await tester.tap(find.widgetWithText(FilledButton, 'Send'));
      await tester.pump();
      await fakeChannel.nextClientMessage(); // submit

      fakeChannel.sendFromServer(
        const DaemonAckMessage(
          threadId: kDefaultMainThreadId,
          requestId: 'req-stream-ui-1',
          submissionId: 'sub-1',
        ),
      );
      fakeChannel.sendFromServer(
        const DaemonDeltaMessage(
          protocolVersion: 1,
          threadId: kDefaultMainThreadId,
          seq: 1,
          event: DeltaTurnStartEvent(
            messageId: 'm-owner-1',
            role: ThreadMessageRole.owner,
            text: 'Hello',
            requestId: 'req-stream-ui-1',
            createdAt: '2026-11-27T12:00:00.000Z',
          ),
        ),
      );
      fakeChannel.sendFromServer(
        const DaemonDeltaMessage(
          protocolVersion: 1,
          threadId: kDefaultMainThreadId,
          seq: 2,
          event: DeltaTurnFinishEvent(messageId: 'm-owner-1'),
        ),
      );
      fakeChannel.sendFromServer(
        const DaemonDeltaMessage(
          protocolVersion: 1,
          threadId: kDefaultMainThreadId,
          seq: 3,
          event: DeltaTurnStartEvent(
            messageId: 'live-gen-1',
            role: ThreadMessageRole.agent,
            createdAt: '2026-11-27T12:00:01.000Z',
          ),
        ),
      );
      fakeChannel.sendFromServer(
        const DaemonDeltaMessage(
          protocolVersion: 1,
          threadId: kDefaultMainThreadId,
          seq: 4,
          event: DeltaTextDeltaEvent(messageId: 'live-gen-1', delta: 'Good '),
        ),
      );
      await tester.pump();

      expect(find.text('Streaming'), findsOneWidget);
      expect(find.text('Good '), findsOneWidget);

      fakeChannel.sendFromServer(
        const DaemonDeltaMessage(
          protocolVersion: 1,
          threadId: kDefaultMainThreadId,
          seq: 5,
          event: DeltaTextDeltaEvent(
            messageId: 'live-gen-1',
            delta: 'morning!',
          ),
        ),
      );
      fakeChannel.sendFromServer(
        const DaemonDeltaMessage(
          protocolVersion: 1,
          threadId: kDefaultMainThreadId,
          seq: 6,
          event: DeltaTurnFinishEvent(messageId: 'live-gen-1'),
        ),
      );
      await tester.pump();

      expect(find.text('Connected'), findsOneWidget);
      expect(find.text('Good morning!'), findsOneWidget);

      // A turn_error updates status to Error, displays error message, and still allows follow-up submit.
      fakeChannel.sendFromServer(
        const DaemonDeltaMessage(
          protocolVersion: 1,
          threadId: kDefaultMainThreadId,
          seq: 7,
          event: DeltaTurnStartEvent(
            messageId: 'live-gen-2',
            role: ThreadMessageRole.agent,
            createdAt: '2026-11-27T12:00:02.000Z',
          ),
        ),
      );
      fakeChannel.sendFromServer(
        const DaemonDeltaMessage(
          protocolVersion: 1,
          threadId: kDefaultMainThreadId,
          seq: 8,
          event: DeltaTurnErrorEvent(
            messageId: 'live-gen-2',
            status: ThreadMessageStatus.error,
            message: 'Model request failed.',
          ),
        ),
      );
      await tester.pump();

      // A failed turn is not a dropped connection: stay Connected, no Reconnect button,
      // show the turn error in the Thread and a banner, and keep the composer usable.
      expect(find.text('Connected'), findsOneWidget);
      expect(find.text('Error'), findsNothing);
      expect(find.widgetWithText(OutlinedButton, 'Reconnect'), findsNothing);
      expect(find.text('Model request failed.'), findsOneWidget);
      expect(
        find.text(
          'Alfred could not finish the last reply: Model request failed.',
        ),
        findsOneWidget,
      );
      expect(tester.widget<TextField>(find.byType(TextField)).enabled, isTrue);

      // Sending the next prompt clears the turn error banner.
      await tester.enterText(find.byType(TextField), 'Try again');
      await tester.pump();
      await tester.tap(find.widgetWithText(FilledButton, 'Send'));
      await tester.pump();
      final ClientMessage retry = await fakeChannel.nextClientMessage();
      expect(retry, isA<ClientSubmitMessage>());
      expect(
        find.text(
          'Alfred could not finish the last reply: Model request failed.',
        ),
        findsNothing,
      );

      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets(
    'resyncs mid-stream disconnect via hello -> snapshot -> delta without losing or duplicating tokens',
    (WidgetTester tester) async {
      final List<_FakeWebSocketChannel> channels = <_FakeWebSocketChannel>[];

      await tester.pumpWidget(
        AlfredApp(
          daemonBaseUri: Uri.parse('http://127.0.0.1:4040'),
          webSocketChannelFactory: (Uri _) {
            final _FakeWebSocketChannel channel = _FakeWebSocketChannel();
            channels.add(channel);
            return channel;
          },
          reconnectDelay: (_) => Duration.zero,
          maxReconnectAttempts: 3,
        ),
      );
      await tester.pump();
      await channels.first.nextClientMessage(); // hello

      channels.first.sendFromServer(
        const DaemonSnapshotMessage(
          protocolVersion: 1,
          seq: 0,
          thread: ThreadSnapshot(
            id: kDefaultMainThreadId,
            agentName: kDefaultMainAgentName,
            status: ThreadStatus.idle,
            messages: <ThreadMessage>[],
          ),
        ),
      );
      await tester.pumpAndSettle();

      channels.first.sendFromServer(
        const DaemonDeltaMessage(
          protocolVersion: 1,
          threadId: kDefaultMainThreadId,
          seq: 1,
          event: DeltaTurnStartEvent(
            messageId: 'live-gen-1',
            role: ThreadMessageRole.agent,
            createdAt: '2026-11-27T12:00:00.000Z',
          ),
        ),
      );
      channels.first.sendFromServer(
        const DaemonDeltaMessage(
          protocolVersion: 1,
          threadId: kDefaultMainThreadId,
          seq: 2,
          event: DeltaTextDeltaEvent(messageId: 'live-gen-1', delta: 'Part 1 '),
        ),
      );
      await tester.pump();
      expect(find.text('Streaming'), findsOneWidget);
      expect(find.text('Part 1 '), findsOneWidget);

      // Socket drops mid-stream and auto-reconnects.
      channels.first.closeFromServer(1006, 'network_drop');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 1));
      expect(channels, hasLength(2));

      final ClientMessage hello2 = await channels[1].nextClientMessage();
      expect(hello2, isA<ClientHelloMessage>());

      // Daemon sends fresh snapshot with seq: 3 (already includes 'Part 1 Part 2 ').
      channels[1].sendFromServer(
        const DaemonSnapshotMessage(
          protocolVersion: 1,
          seq: 3,
          thread: ThreadSnapshot(
            id: kDefaultMainThreadId,
            agentName: kDefaultMainAgentName,
            status: ThreadStatus.streaming,
            messages: <ThreadMessage>[
              ThreadMessage(
                id: 'live-gen-1',
                role: ThreadMessageRole.agent,
                text: 'Part 1 Part 2 ',
                status: ThreadMessageStatus.streaming,
                createdAt: '2026-11-27T12:00:00.000Z',
              ),
            ],
          ),
        ),
      );
      // Stale delta (seq <= 3) must be ignored; seq 4 and 5 apply cleanly.
      channels[1].sendFromServer(
        const DaemonDeltaMessage(
          protocolVersion: 1,
          threadId: kDefaultMainThreadId,
          seq: 3,
          event: DeltaTextDeltaEvent(messageId: 'live-gen-1', delta: 'Part 2 '),
        ),
      );
      channels[1].sendFromServer(
        const DaemonDeltaMessage(
          protocolVersion: 1,
          threadId: kDefaultMainThreadId,
          seq: 4,
          event: DeltaTextDeltaEvent(messageId: 'live-gen-1', delta: 'Part 3!'),
        ),
      );
      channels[1].sendFromServer(
        const DaemonDeltaMessage(
          protocolVersion: 1,
          threadId: kDefaultMainThreadId,
          seq: 5,
          event: DeltaTurnFinishEvent(messageId: 'live-gen-1'),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Connected'), findsOneWidget);
      expect(find.text('Part 1 Part 2 Part 3!'), findsOneWidget);

      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets(
    'preserves unacknowledged requestId across disconnect and retries automatically with same requestId',
    (WidgetTester tester) async {
      final List<_FakeWebSocketChannel> channels = <_FakeWebSocketChannel>[];
      int requestCounter = 0;

      await tester.pumpWidget(
        AlfredApp(
          daemonBaseUri: Uri.parse('http://127.0.0.1:4040'),
          webSocketChannelFactory: (Uri _) {
            final _FakeWebSocketChannel channel = _FakeWebSocketChannel();
            channels.add(channel);
            return channel;
          },
          requestIdGenerator: () {
            requestCounter += 1;
            return 'req-retry-$requestCounter';
          },
          reconnectDelay: (_) => Duration.zero,
          maxReconnectAttempts: 3,
        ),
      );
      await tester.pump();
      await channels.first.nextClientMessage(); // hello

      channels.first.sendFromServer(
        const DaemonSnapshotMessage(
          protocolVersion: 1,
          seq: 0,
          thread: ThreadSnapshot(
            id: kDefaultMainThreadId,
            agentName: kDefaultMainAgentName,
            status: ThreadStatus.idle,
            messages: <ThreadMessage>[],
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Submit a prompt; no ack arrives before the socket drops.
      await tester.enterText(find.byType(TextField), 'Retry me');
      await tester.pump();
      await tester.tap(find.widgetWithText(FilledButton, 'Send'));
      await tester.pump();

      final ClientSubmitMessage firstSubmit =
          await channels.first.nextClientMessage() as ClientSubmitMessage;
      expect(firstSubmit.requestId, 'req-retry-1');
      expect(firstSubmit.text, 'Retry me');

      channels.first.closeFromServer(1006, 'dropped_before_ack');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 1));
      expect(channels, hasLength(2));

      await channels[1].nextClientMessage(); // hello
      // Snapshot after reconnect does NOT include req-retry-1 -> client automatically retries with same requestId.
      channels[1].sendFromServer(
        const DaemonSnapshotMessage(
          protocolVersion: 1,
          seq: 0,
          thread: ThreadSnapshot(
            id: kDefaultMainThreadId,
            agentName: kDefaultMainAgentName,
            status: ThreadStatus.idle,
            messages: <ThreadMessage>[],
          ),
        ),
      );
      await tester.pump();

      final ClientSubmitMessage retriedSubmit =
          await channels[1].nextClientMessage() as ClientSubmitMessage;
      expect(retriedSubmit.requestId, 'req-retry-1');
      expect(retriedSubmit.text, 'Retry me');
      expect(requestCounter, 1);

      // Ack arrives on the reconnected socket.
      channels[1].sendFromServer(
        const DaemonAckMessage(
          threadId: kDefaultMainThreadId,
          requestId: 'req-retry-1',
          submissionId: 'sub-retry-1',
        ),
      );
      await tester.pump();

      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets(
    'skips retry when pending requestId is already in reconnect snapshot and resyncs on sequence gap',
    (WidgetTester tester) async {
      final List<_FakeWebSocketChannel> channels = <_FakeWebSocketChannel>[];

      await tester.pumpWidget(
        AlfredApp(
          daemonBaseUri: Uri.parse('http://127.0.0.1:4040'),
          webSocketChannelFactory: (Uri _) {
            final _FakeWebSocketChannel channel = _FakeWebSocketChannel();
            channels.add(channel);
            return channel;
          },
          requestIdGenerator: () => 'req-already-persisted',
          reconnectDelay: (_) => Duration.zero,
          maxReconnectAttempts: 3,
        ),
      );
      await tester.pump();
      await channels.first.nextClientMessage(); // hello

      channels.first.sendFromServer(
        const DaemonSnapshotMessage(
          protocolVersion: 1,
          seq: 0,
          thread: ThreadSnapshot(
            id: kDefaultMainThreadId,
            agentName: kDefaultMainAgentName,
            status: ThreadStatus.idle,
            messages: <ThreadMessage>[],
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField), 'Persisted before ack');
      await tester.pump();
      await tester.tap(find.widgetWithText(FilledButton, 'Send'));
      await tester.pump();
      await channels.first.nextClientMessage(); // submit

      // Drop before ack, reconnect, and snapshot already has req-already-persisted.
      channels.first.closeFromServer(1006, 'drop');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 1));
      expect(channels, hasLength(2));
      await channels[1].nextClientMessage(); // hello

      channels[1].sendFromServer(
        const DaemonSnapshotMessage(
          protocolVersion: 1,
          seq: 2,
          thread: ThreadSnapshot(
            id: kDefaultMainThreadId,
            agentName: kDefaultMainAgentName,
            status: ThreadStatus.idle,
            messages: <ThreadMessage>[
              ThreadMessage(
                id: 'entry-1',
                role: ThreadMessageRole.owner,
                text: 'Persisted before ack',
                status: ThreadMessageStatus.complete,
                requestId: 'req-already-persisted',
                createdAt: '2026-11-27T12:00:00.000Z',
              ),
            ],
          ),
        ),
      );
      await tester.pump();

      // Send a delta with a sequence gap (seq 5 when lastSeq is 2) -> triggers resync reconnect!
      channels[1].sendFromServer(
        const DaemonDeltaMessage(
          protocolVersion: 1,
          threadId: kDefaultMainThreadId,
          seq: 5,
          event: DeltaTextDeltaEvent(messageId: 'entry-2', delta: 'gapped'),
        ),
      );
      await tester.pump();
      expect(channels, hasLength(3));

      final ClientMessage hello3 = await channels[2].nextClientMessage();
      expect(hello3, isA<ClientHelloMessage>());
      channels[2].sendFromServer(
        const DaemonSnapshotMessage(
          protocolVersion: 1,
          seq: 5,
          thread: ThreadSnapshot(
            id: kDefaultMainThreadId,
            agentName: kDefaultMainAgentName,
            status: ThreadStatus.idle,
            messages: <ThreadMessage>[
              ThreadMessage(
                id: 'entry-1',
                role: ThreadMessageRole.owner,
                text: 'Persisted before ack',
                status: ThreadMessageStatus.complete,
                requestId: 'req-already-persisted',
                createdAt: '2026-11-27T12:00:00.000Z',
              ),
              ThreadMessage(
                id: 'entry-2',
                role: ThreadMessageRole.agent,
                text: 'Recovered after gap',
                status: ThreadMessageStatus.complete,
                createdAt: '2026-11-27T12:00:01.000Z',
              ),
            ],
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Recovered after gap'), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets('navigates to HealthCheckScreen from ThreadScreen AppBar', (
    WidgetTester tester,
  ) async {
    late _FakeWebSocketChannel fakeChannel;
    final MockClient httpClient = MockClient((http.Request request) async {
      expect(request.url.path, '/health');
      return http.Response(
        jsonEncode(<String, Object>{
          'ok': true,
          'service': 'alfred-daemon',
          'protocolVersion': 1,
        }),
        200,
      );
    });

    await tester.pumpWidget(
      AlfredApp(
        daemonBaseUri: Uri.parse('http://127.0.0.1:4040'),
        httpClient: httpClient,
        webSocketChannelFactory: (Uri _) {
          fakeChannel = _FakeWebSocketChannel();
          return fakeChannel;
        },
      ),
    );
    await tester.pump();

    await tester.tap(find.byTooltip('Daemon health'));
    await tester.pumpAndSettle();

    expect(find.text('Daemon connected'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  test('AlfredWsClient completes hello -> snapshot -> submit against real in-process WebSocket server', () async {
    final HttpServer server = await HttpServer.bind(
      InternetAddress.loopbackIPv4,
      0,
    );
    addTearDown(() async {
      await server.close(force: true);
    });

    final List<ClientMessage> received = <ClientMessage>[];
    final StreamSubscription<HttpRequest> serverSub = server.listen((
      HttpRequest request,
    ) async {
      expect(request.uri.path, '/ws');
      final WebSocket socket = await WebSocketTransformer.upgrade(request);
      socket.listen((Object? raw) {
        final ClientMessage msg = ClientMessage.fromJsonObject(
          jsonDecode(raw! as String),
        );
        received.add(msg);
        if (msg is ClientHelloMessage) {
          socket.add(
            jsonEncode(
              const DaemonSnapshotMessage(
                protocolVersion: 1,
                seq: 0,
                thread: ThreadSnapshot(
                  id: kDefaultMainThreadId,
                  agentName: kDefaultMainAgentName,
                  status: ThreadStatus.idle,
                  messages: <ThreadMessage>[],
                ),
              ).toJson(),
            ),
          );
        } else if (msg is ClientSubmitMessage) {
          socket.add(
            jsonEncode(
              DaemonAckMessage(
                threadId: msg.threadId,
                requestId: msg.requestId,
                submissionId: 'sub-real-1',
                deduplicated: false,
              ).toJson(),
            ),
          );
          socket.add(
            jsonEncode(
              DaemonSnapshotMessage(
                protocolVersion: 1,
                seq: 1,
                thread: ThreadSnapshot(
                  id: msg.threadId,
                  agentName: kDefaultMainAgentName,
                  status: ThreadStatus.idle,
                  messages: <ThreadMessage>[
                    ThreadMessage(
                      id: 'm1',
                      role: ThreadMessageRole.owner,
                      text: msg.text,
                      status: ThreadMessageStatus.complete,
                      requestId: msg.requestId,
                      createdAt: '2026-11-27T12:00:00.000Z',
                    ),
                  ],
                ),
              ).toJson(),
            ),
          );
        }
      });
    });
    addTearDown(serverSub.cancel);

    final AlfredWsClient client = AlfredWsClient(
      daemonBaseUri: Uri.parse('http://127.0.0.1:${server.port}'),
      requestIdGenerator: () => 'req-real-1',
    );
    addTearDown(client.dispose);

    final Completer<void> connected = Completer<void>();
    final Completer<void> gotReply = Completer<void>();
    client.addListener(() {
      if (client.status == ThreadConnectionStatus.connected &&
          !connected.isCompleted) {
        connected.complete();
      }
      if ((client.thread?.messages.length ?? 0) == 1 && !gotReply.isCompleted) {
        gotReply.complete();
      }
    });

    client.connect();
    await connected.future;
    client.submitPrompt('Real socket test');
    await gotReply.future;

    expect(received, hasLength(2));
    expect(client.thread!.messages.single.text, 'Real socket test');
  });
}
