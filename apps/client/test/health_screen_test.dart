import 'dart:convert';
import 'dart:io';

import 'package:alfred_client/app.dart';
import 'package:alfred_client/daemon_health.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

String _healthJson({bool ok = true, int protocolVersion = 1}) {
  return jsonEncode(<String, Object>{
    'ok': ok,
    'service': 'alfred-daemon',
    'protocolVersion': protocolVersion,
  });
}

Future<void> _pumpWithClient(WidgetTester tester, MockClient client) async {
  await tester.pumpWidget(
    MaterialApp(
      home: HealthCheckScreen(
        daemonBaseUri: Uri.parse('http://127.0.0.1:4040'),
        httpClient: client,
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  test('parses shared protocol golden health fixture', () {
    final File fixtureFile = File(
      '../../packages/protocol/health.fixture.json',
    );
    final Object? decoded = jsonDecode(fixtureFile.readAsStringSync());
    final DaemonHealth health = DaemonHealth.fromJsonObject(decoded);

    expect(health.ok, isTrue);
    expect(health.service, 'alfred-daemon');
    expect(health.isProtocolCompatible(), isTrue);
  });

  testWidgets('shows connected status when daemon protocol matches', (
    WidgetTester tester,
  ) async {
    final MockClient client = MockClient((http.Request request) async {
      expect(request.url.path, '/health');
      return http.Response(_healthJson(), 200);
    });

    await _pumpWithClient(tester, client);

    expect(find.text('Daemon connected'), findsOneWidget);
    expect(find.textContaining('alfred-daemon'), findsOneWidget);
    expect(find.textContaining('Protocol v1 (compatible)'), findsOneWidget);
  });

  testWidgets(
    'shows unhealthy status when ok is false even if protocol matches',
    (WidgetTester tester) async {
      final MockClient client = MockClient(
        (http.Request _) async => http.Response(_healthJson(ok: false), 200),
      );

      await _pumpWithClient(tester, client);

      expect(find.text('Daemon unhealthy'), findsOneWidget);
      expect(find.textContaining('Protocol v1 (compatible)'), findsOneWidget);
    },
  );

  testWidgets('shows incompatible status when daemon protocol differs', (
    WidgetTester tester,
  ) async {
    final MockClient client = MockClient(
      (http.Request _) async =>
          http.Response(_healthJson(protocolVersion: 99), 200),
    );

    await _pumpWithClient(tester, client);

    expect(find.text('Incompatible protocol'), findsOneWidget);
    expect(find.textContaining('v99'), findsOneWidget);
    expect(find.textContaining('expected v1'), findsOneWidget);
  });

  testWidgets('shows unreachable state and retries when tapped', (
    WidgetTester tester,
  ) async {
    int attempts = 0;
    final MockClient client = MockClient((http.Request _) async {
      attempts += 1;
      if (attempts == 1) {
        throw Exception('connection refused');
      }
      return http.Response(_healthJson(), 200);
    });

    await _pumpWithClient(tester, client);
    expect(find.text('Daemon unreachable'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, 'Retry'));
    await tester.pumpAndSettle();

    expect(find.text('Daemon connected'), findsOneWidget);
  });
}
