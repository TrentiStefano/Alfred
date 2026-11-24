# iOS Home Screen Web Push: requirements and constraints

Research for issue #3. Checked against primary sources as of November 2026 (latest Safari release: Safari 27, September 2026).

## 1. Platform requirements

- **Minimum OS:** Web Push works for Home Screen web apps on iOS/iPadOS 16.4 or later. In Safari on iOS it does not work for ordinary tabs. ([Apple: Sending web push notifications](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers), [WebKit blog: Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/))
- **Home Screen install and manifest:** The site needs a manifest whose `display` is `standalone` or `fullscreen` ([WebKit 13878](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)). MDN's compat data says `Notification` is undefined unless the page is a web app saved to the Home Screen with a non-default `display` value ([MDN BCD: Notification](https://github.com/mdn/browser-compat-data/blob/main/api/Notification.json)). Since iOS/iPadOS 26, a site added to the Home Screen opens as a web app by default, even without a manifest, unless the user turns off "Open as Web App" ([Safari 26 release notes](https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes), [WebKit: Safari 26.0 features](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)). Shipping a manifest with `display: standalone` is still the safe choice.
- **Service worker:** The classic flow uses the Push, Notifications and Service Worker APIs together ([WebKit 13878](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/), [W3C Push API](https://www.w3.org/TR/push-api/)). The push subscription belongs to the service worker registration, so its scope must cover the app's pages. Service workers need a secure context (HTTPS) ([W3C Service Workers](https://www.w3.org/TR/service-workers/)).
- **User gesture:** Permission must be requested in direct response to a user action, such as tapping a button. Call the subscribe method straight from that gesture's event handler ([Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers), [WebKit 13878](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)).
- **No Apple Developer account** is needed ([Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)).
- **Badging:** `navigator.setAppBadge` / `clearAppBadge` are supported. The user controls badging in Notifications settings ([Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers), [WebKit 13878](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)).

## 2. Payload size and the "always show a notification" rule

- **Payload limit:** 4 KB. Larger payloads get `413` / `PayloadTooLarge` ([Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)).
- **No silent push:** Safari does not support invisible push notifications. The service worker must show a notification immediately after it receives a push. If it does not, "Safari revokes the push notification permission for your site" ([Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)). Subscriptions must use `userVisibleOnly: true` ([WebKit: Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/), [W3C Push API](https://www.w3.org/TR/push-api/)). Push therefore cannot be used as a background-sync wake-up.
- **Declarative Web Push (iOS/iPadOS 18.4+):** The push payload is JSON with `"web_push": 8030`, a `notification` object (a non-empty `title` is required) and a required `navigate` URL. The system shows the notification without running a service worker. A service worker, if present, may replace the notification, and the original is shown if it does not do so in time. `window.pushManager` lets the page subscribe without a service worker. Because a declarative message always produces a visible notification, silent-push penalties cannot happen ([WebKit 16535](https://webkit.org/blog/16535/meet-declarative-web-push/)). Safari 26.2 fixed parsing of the declarative `mutable` field ([Safari 26.2 release notes](https://developer.apple.com/documentation/safari-release-notes/safari-26_2-release-notes)).

## 3. Server side: VAPID, headers, expiry, 410 Gone

- **VAPID is mandatory** ([RFC 8292](https://www.rfc-editor.org/rfc/rfc8292)). The `Authorization` header carries the JWT and public key, and that key must match the one passed to `PushManager.subscribe` (otherwise `VapidPkHashMismatch`). The JWT `sub` must be a URL or `mailto:`, and `aud` must be the push service origin. `exp` may be at most one day ahead. Do not refresh the JWT more than once per hour ([Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)).
- **Encryption:** Payloads use the standard Web Push message encryption ([RFC 8291](https://www.rfc-editor.org/rfc/rfc8291)). Requests follow [RFC 8030](https://www.rfc-editor.org/rfc/rfc8030) over HTTP/1.1 or HTTP/2, with TLS and SNI. If egress is filtered, allow `https://*.push.apple.com` ([Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)).
- **Headers:**
  - `TTL` is required. Apple stores the message for up to 30 days while the device is offline, and the number of stored messages is limited.
  - `Urgency` is one of `very-low | low | normal | high`. Use `high` for immediate delivery.
  - `Topic` is an optional coalescing key of up to 32 base64url characters.

  ([Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers))
- **Status codes:**
  - `201` means success.
  - `403` means an authentication error.
  - `410` means "The device token has expired".
  - `413` means the payload is too large.
  - `429` means too many requests to the same device.

  Errors include a JSON `reason` ([Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)). RFC 8030 signals an expired subscription with `404` ([RFC 8030 §7.3](https://www.rfc-editor.org/rfc/rfc8030#section-7.3)), while Apple documents `410` for an expired token and `404` for an invalid path. The server should therefore delete the subscription and stop sending on either `404` or `410`.
- **Expiry and renewal:** iOS supports `PushSubscription.expirationTime`, but it does **not** support the `pushsubscriptionchange` event ([MDN BCD: PushSubscription](https://github.com/mdn/browser-compat-data/blob/main/api/PushSubscription.json), [MDN BCD: ServiceWorkerGlobalScope](https://github.com/mdn/browser-compat-data/blob/main/api/ServiceWorkerGlobalScope.json)). The server cannot learn about a rotated subscription from the device in the background. It has to treat `410` as the signal, and the app should call `getSubscription()` on every launch and re-register with the server if the subscription changed.

## 4. Tailscale Serve `*.ts.net` origin

- **Certificate:** Tailscale HTTPS certificates come from Let's Encrypt, a public CA, for `<machine>.<tailnet>.ts.net`. MagicDNS must be enabled. Machine names are published in the public Certificate Transparency logs ([Tailscale: Enabling HTTPS](https://tailscale.com/kb/1153/enabling-https)). A publicly trusted certificate meets the secure-context requirement, so no custom CA profile is needed on the phone. Neither Apple nor WebKit adds any requirement about which CA issued the origin's certificate.
- **Reachability:** Serve makes a local service "available within your tailnet". Public exposure needs Funnel ([Tailscale Serve](https://tailscale.com/kb/1312/serve)). The phone must therefore be connected to the tailnet (Tailscale app active) to load the app, install it to the Home Screen, subscribe, and make any request to the daemon.
- **Push delivery does not need the tailnet:** The daemon POSTs to the subscription endpoint on `*.push.apple.com`, and Apple's push service delivers to the device ([Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)). The daemon needs outbound internet access to Apple, and the phone only needs ordinary connectivity to Apple. The notification can be shown entirely from the encrypted payload, or declaratively with no service worker at all. The tailnet matters only if the service worker or the opened app then fetches from the daemon. If the phone is off the tailnet, that fetch fails. The notification must still be shown or the permission is revoked, so never make the notification depend on a daemon fetch.
- This is an inference from the sources above, not a documented Apple or Tailscale statement. A device test should confirm it.

## 5. Notification action buttons (approve/reject)

- **Not supported on iOS/iPadOS or Safari.** MDN's compat data lists `Notification.actions`, `maxActions`, the `actions` option of `showNotification`, `NotificationEvent.action` and `requireInteraction` as unsupported in Safari, and Safari on iOS mirrors that ([MDN BCD: Notification](https://github.com/mdn/browser-compat-data/blob/main/api/Notification.json), [MDN BCD: ServiceWorkerRegistration](https://github.com/mdn/browser-compat-data/blob/main/api/ServiceWorkerRegistration.json), [MDN BCD: NotificationEvent](https://github.com/mdn/browser-compat-data/blob/main/api/NotificationEvent.json)).
- The Declarative Web Push format has no actions field ([WebKit 16535](https://webkit.org/blog/16535/meet-declarative-web-push/)).
- No Safari 26.x or Safari 27 release note adds notification actions ([Safari 27 release notes](https://developer.apple.com/documentation/safari-release-notes/safari-27-release-notes)).
- The only interaction is tapping the notification, which opens the app at a URL (declarative `navigate`, or `clients.openWindow` in a service worker).
- MDN's compat data currently also marks `notificationclick` as unsupported on iOS. Verify on a device before relying on service worker click handling. Declarative `navigate` is the documented path.

## Implications for Alfred

- An **Approval** cannot be accepted or rejected from the notification. The push is a deep link (`navigate: /approvals/<id>`). The Owner taps it, the app opens, and the Owner approves in-app over the tailnet.
- Use **Declarative Web Push** payloads (title, short body, `navigate`), each under 4 KB. Never send a push that will not show a notification. A "sync now" push is not possible.
- Do not put secrets or full **Briefing** content in the payload, and do not depend on fetching from the daemon to render the notification.
- The daemon needs a VAPID key pair (stable, stored as a secret), egress to `*.push.apple.com`, a 410/404 prune path, and `TTL` / `Urgency` / `Topic` set per message (for example, `Topic` per Approval for coalescing).
- The app must call `getSubscription()` on every launch and re-register with the server if it changed, since iOS has no `pushsubscriptionchange`.
- Permission must be requested from an explicit "Enable notifications" button in the installed Home Screen app.
- Tailscale Serve on `*.ts.net` is sufficient for install and push. Machine names become public in CT logs, so pick a neutral one.

## Answer

iOS/iPadOS 16.4+ supports Web Push only for Home Screen web apps, with these hard constraints:

- **Install and permission:** The app must be installed with a standalone/fullscreen manifest (iOS 26 opens any Home Screen site as a web app by default). Service workers need HTTPS. Permission must be requested from a user gesture.
- **Every push must show a notification.** Payloads are at most 4 KB, and silent pushes cause Safari to revoke permission. Declarative Web Push (iOS 18.4+) removes that risk and the need for a service worker.
- **Server:** VAPID is mandatory, with a key that matches the subscription. A `410` (or `404`) means the subscription is dead and should be deleted. iOS has no `pushsubscriptionchange`, so the app re-checks its subscription on launch.
- **Tailscale:** A Tailscale Serve `*.ts.net` origin works, because its certificate comes from Let's Encrypt and is publicly trusted. The phone must be on the tailnet to install the app and talk to the daemon. Push delivery itself goes daemon → Apple's push service → phone and does not need the tailnet, as long as the notification is built from the payload alone.
- **No action buttons:** Notification action buttons are not supported on iOS as of Safari 27, so an Approval is a tap-through deep link into the app, not approve/reject on the notification.
