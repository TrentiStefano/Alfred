import 'dart:convert';

import 'package:http/http.dart' as http;

const int kExpectedProtocolVersion = 1;

class DaemonHealth {
  const DaemonHealth({
    required this.ok,
    required this.service,
    required this.protocolVersion,
  });

  final bool ok;
  final String service;
  final int protocolVersion;

  bool isProtocolCompatible({int expected = kExpectedProtocolVersion}) {
    return ok && protocolVersion == expected;
  }

  static DaemonHealth fromJsonObject(Object? decoded) {
    if (decoded is! Map<Object?, Object?>) {
      throw const FormatException(
        'Daemon health response must be a JSON object.',
      );
    }
    final Object? ok = decoded['ok'];
    final Object? service = decoded['service'];
    final Object? protocolVersion = decoded['protocolVersion'];
    if (ok is! bool || service is! String || protocolVersion is! int) {
      throw const FormatException(
        'Daemon health response is missing required fields.',
      );
    }
    return DaemonHealth(
      ok: ok,
      service: service,
      protocolVersion: protocolVersion,
    );
  }
}

Future<DaemonHealth> fetchDaemonHealth({
  required Uri baseUri,
  required http.Client client,
}) async {
  final Uri endpoint = baseUri.resolve('/health');
  final http.Response response = await client.get(endpoint);
  if (response.statusCode != 200) {
    throw http.ClientException(
      'Unexpected status ${response.statusCode}',
      endpoint,
    );
  }
  final Object? decoded = jsonDecode(response.body);
  return DaemonHealth.fromJsonObject(decoded);
}
