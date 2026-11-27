import 'dart:convert';
import 'dart:io';

import 'package:alfred_client/ws_protocol.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, Object?> _readFixtureMap(String relativePath) {
  final File file = File(relativePath);
  final Object? decoded = jsonDecode(file.readAsStringSync());
  if (decoded is! Map<String, Object?>) {
    throw StateError('Fixture $relativePath must be a JSON object.');
  }
  return decoded;
}

void main() {
  test('round-trips every valid WebSocket golden fixture', () {
    final Map<String, Object?> valid = _readFixtureMap(
      '../../packages/protocol/ws-valid.fixture.json',
    );
    final Map<String, Object?> clientFixtures =
        valid['client']! as Map<String, Object?>;
    final Map<String, Object?> daemonFixtures =
        valid['daemon']! as Map<String, Object?>;

    for (final MapEntry<String, Object?> entry in clientFixtures.entries) {
      final ClientMessage parsed = ClientMessage.fromJsonObject(entry.value);
      expect(
        parsed.toJson(),
        entry.value,
        reason: 'client fixture ${entry.key} should round-trip identically',
      );
    }

    for (final MapEntry<String, Object?> entry in daemonFixtures.entries) {
      final DaemonMessage parsed = DaemonMessage.fromJsonObject(entry.value);
      expect(
        parsed.toJson(),
        entry.value,
        reason: 'daemon fixture ${entry.key} should round-trip identically',
      );
    }
  });

  test('rejects every invalid WebSocket golden fixture', () {
    final Map<String, Object?> invalid = _readFixtureMap(
      '../../packages/protocol/ws-invalid.fixture.json',
    );
    final List<Object?> clientCases = invalid['client']! as List<Object?>;
    final List<Object?> daemonCases = invalid['daemon']! as List<Object?>;

    for (final Object? rawCase in clientCases) {
      final Map<String, Object?> testCase = rawCase! as Map<String, Object?>;
      final String name = testCase['name']! as String;
      expect(
        () => ClientMessage.fromJsonObject(testCase['payload']),
        throwsA(isA<FormatException>()),
        reason: 'invalid client fixture $name should throw FormatException',
      );
    }

    for (final Object? rawCase in daemonCases) {
      final Map<String, Object?> testCase = rawCase! as Map<String, Object?>;
      final String name = testCase['name']! as String;
      expect(
        () => DaemonMessage.fromJsonObject(testCase['payload']),
        throwsA(isA<FormatException>()),
        reason: 'invalid daemon fixture $name should throw FormatException',
      );
    }
  });
}
