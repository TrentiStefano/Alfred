import 'daemon_config.dart';

Uri resolvePlatformDaemonBaseUri({
  required String fallbackUrl,
  Uri? webPageUri,
  String? envDaemonUrl,
}) {
  return resolveWebDaemonBaseUri(
    pageUri: webPageUri ?? Uri.base,
    fallbackUrl: fallbackUrl,
  );
}
