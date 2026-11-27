import 'dart:convert';

import 'package:alfred_client/app.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  testWidgets('shows connected status when daemon protocol matches', (
    WidgetTester tester,
  ) async {
    final MockClient client = MockClient((http.Request request) async {
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
        httpClient: client,
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Daemon connected'), findsOneWidget);
    expect(find.textContaining('alfred-daemon'), findsOneWidget);
    expect(find.textContaining('Protocol v1 (compatible)'), findsOneWidget);
  });

  testWidgets('shows incompatible status when daemon protocol differs', (
    WidgetTester tester,
  ) async {
    final MockClient client = MockClient((http.Request request) async {
      return http.Response(
        jsonEncode(<String, Object>{
          'ok': true,
          'service': 'alfred-daemon',
          'protocolVersion': 99,
        }),
        200,
      );
    });

    await tester.pumpWidget(
      AlfredApp(
        daemonBaseUri: Uri.parse('http://127.0.0.1:4040'),
        httpClient: client,
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Incompatible protocol'), findsOneWidget);
    expect(find.textContaining('v99'), findsOneWidget);
    expect(find.textContaining('expected v1'), findsOneWidget);
  });

  testWidgets('shows unreachable state and retries when tapped', (
    WidgetTester tester,
  ) async {
    int attempts = 0;
    final MockClient client = MockClient((http.Request request) async {
      attempts += 1;
      if (attempts == 1) {
        throw Exception('connection refused');
      }
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
        httpClient: client,
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Daemon unreachable'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, 'Retry'));
    await tester.pumpAndSettle();

    expect(find.text('Daemon connected'), findsOneWidget);
  });
}
