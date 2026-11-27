import 'dart:io';

import 'daemon_config.dart';

Uri resolvePlatformDaemonBaseUri({
  required String fallbackUrl,
  Uri? webPageUri,
  String? envDaemonUrl,
}) {
  final String? rawEnv =
      envDaemonUrl ?? Platform.environment['ALFRED_DAEMON_URL'];
  final Uri? parsed = parseValidDaemonUri(rawEnv);
  if (parsed != null) {
    return parsed;
  }
  return Uri.parse(fallbackUrl);
}
