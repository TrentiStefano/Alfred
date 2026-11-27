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

      fakeChannel.closeFromServer();
      await tester.pump();
    },
  );

  testWidgets('surfaces clear version-mismatch error when hello is rejected', (
    WidgetTester tester,
  ) async {
    late _FakeWebSocketChannel fakeChannel;

    await tester.pumpWidget(
      AlfredApp(
        daemonBaseUri: Uri.parse('http://127.0.0.1:4040'),
        webSocketChannelFactory: (Uri _) {
          fakeChannel = _FakeWebSocketChannel();
          return fakeChannel;
        },
      ),
    );
    await tester.pump();

    fakeChannel.sendFromServer(
      const DaemonErrorMessage(
        code: ProtocolErrorCode.unsupportedProtocolVersion,
        message: 'Unsupported protocol version 1; expected 2.',
        protocolVersion: 1,
        expectedProtocolVersion: 2,
      ),
    );
    fakeChannel.closeFromServer(1008, 'unsupported_protocol_version');
    await tester.pumpAndSettle();

    expect(find.text('Error'), findsOneWidget);
    expect(find.textContaining('Unsupported protocol version'), findsOneWidget);
    expect(find.textContaining('v2'), findsOneWidget);
  });

  testWidgets('shows Disconnected on socket close and reconnects on tap', (
    WidgetTester tester,
  ) async {
    final List<_FakeWebSocketChannel> channels = <_FakeWebSocketChannel>[];

    await tester.pumpWidget(
      AlfredApp(
        daemonBaseUri: Uri.parse('http://127.0.0.1:4040'),
        webSocketChannelFactory: (Uri _) {
          final _FakeWebSocketChannel channel = _FakeWebSocketChannel();
          channels.add(channel);
          return channel;
        },
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

    channels.first.closeFromServer(1001, 'server_shutdown');
    await tester.pumpAndSettle();
    expect(find.text('Disconnected'), findsOneWidget);

    await tester.tap(find.widgetWithText(OutlinedButton, 'Reconnect'));
    await tester.pump();
    expect(channels, hasLength(2));

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

    channels.last.closeFromServer();
    await tester.pump();
  });

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
    fakeChannel.closeFromServer();
    await tester.pump();
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
