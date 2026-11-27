Uri resolvePlatformDaemonBaseUri({
  required String fallbackUrl,
  Uri? webPageUri,
  String? envDaemonUrl,
}) {
  return Uri.parse(fallbackUrl);
}
