# Browser push integration

The API implements standard Web Push through the `web-push` library. Appointment delivery
creates one durable job per subscribed browser, encrypts the payload with that browser's keys,
and authenticates the send with the server's VAPID key pair. The push service accepting a
request does not prove that the user saw the notification. Email and push are supported;
SMS delivery is deferred.

This document is a frontend integration contract and example code. It does not add or deploy
a frontend service worker. The frontend must implement and test the browser permission,
subscription, display, click, and logout flows before browser notifications are usable.

## Server configuration

Set `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY` and `WEB_PUSH_SUBJECT` on the serving stage.
The subject is an HTTPS contact URL or `mailto:` address. Generate the key pair once with
`bunx web-push generate-vapid-keys`, store the private key as a secret, and keep the pair stable.
Changing the public key requires browsers to unsubscribe and resubscribe with the new key.
Only the public key is returned to authenticated clients. Missing either key disables push.

Known provider endpoints are accepted: `fcm.googleapis.com`, Mozilla's
`push.services.mozilla.com` subdomains, and `web.push.apple.com`. Arbitrary HTTPS URLs and
private destinations are rejected. Unsupported browser providers require a reviewed allowlist
change; do not proxy arbitrary URLs through the API.

## Subscribe and opt in

Use an HTTPS frontend, an active service worker, and feature detection for `serviceWorker`,
`PushManager` and `Notification`. Request permission from a user action explaining appointment
notifications. Handle denied permission and unsupported browsers without blocking appointments.

1. Authenticate and call `GET /v1/me/push-subscriptions/public-key`. The response is
   `{ "enabled": true, "publicKey": "<base64url VAPID key>" }` when configured, or
   `{ "enabled": false, "publicKey": null }`. Hide or disable setup when unavailable.
2. Subscribe with `userVisibleOnly: true` and the decoded `applicationServerKey`. Reuse an
   existing subscription only when it belongs to the signed-in account and uses the current
   public key; otherwise remove its API registration and unsubscribe first.
3. Send the subscription to authenticated `POST /v1/me/push-subscriptions`:

   ```json
   {
     "endpoint": "<subscription.endpoint>",
     "keys": { "p256dh": "<base64url public key>", "auth": "<base64url auth secret>" }
   }
   ```

   The `200` response contains `{ id, endpoint, keys }`. Retrying or rotating keys for the
   same owned endpoint preserves `id`. Store the registration ID with its account identity
   so that logout and unsubscribe can remove the correct registration. An endpoint owned
   by another account returns `409`; it cannot be reassigned by this request. Each account
   can register at most ten browsers. Unsupported endpoints or malformed keys return `422`.

4. Read `GET /v1/me/notifications`, then send `PATCH /v1/me/notifications` with the
   `appointments` category and `push: true`, preserving that category's current `email` and
   `sms` flags. Updating a category replaces all three flags; do not silently disable email.
   Registering a browser alone does not opt it into push. SMS preferences do not activate
   SMS delivery while that channel is deferred.

Decode the public key before passing it to `PushManager.subscribe`:

```js
function decodeApplicationServerKey(base64url) {
  const padded = base64url
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
```

Use the application's normal authenticated fetch client for these API calls, including its
existing cookie or bearer-token handling and CORS credentials configuration.

## Service worker payload and display

The decrypted JSON payload is:

```json
{
  "title": "Appointment reminder",
  "body": "Your appointment is scheduled for …",
  "tag": "<stable appointment notification tag>",
  "url": "/appointments/<appointment-id>"
}
```

`title` and `body` are localized plain text. `url` is an application-relative destination;
map the appointment route to the frontend's actual routing. `tag` allows the browser to
coalesce duplicate deliveries. It is not an exactly-once delivery guarantee. Keep lock-screen
content minimal: do not add patient names, diagnoses or other clinical details.

Example service worker handlers:

```js
self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let message;
      try {
        message = event.data?.json();
      } catch {
        return;
      }
      if (
        !message ||
        typeof message.title !== "string" ||
        typeof message.body !== "string" ||
        typeof message.tag !== "string" ||
        typeof message.url !== "string"
      )
        return;
      const destination = new URL(message.url, self.location.origin);
      if (destination.origin !== self.location.origin) return;
      await self.registration.showNotification(message.title, {
        body: message.body,
        tag: message.tag,
        data: { url: destination.href },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const destination = new URL(event.notification.data?.url ?? "/", self.location.origin);
      if (destination.origin !== self.location.origin) return;
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find((window) => new URL(window.url).origin === destination.origin);
      if (existing) {
        await existing.navigate(destination.href);
        await existing.focus();
      } else {
        await self.clients.openWindow(destination.href);
      }
    })(),
  );
});
```

Treat push data as untrusted input. The examples reject external origins; production handlers
should also bound payload strings and map only supported application routes. The destination page must
perform normal authentication and authorization before displaying appointment details. A
notification must never contain a bearer token or grant access on its own.

## Unsubscribe, logout and account switching

To stop all appointment pushes for an account, turn off its appointments push preference.
To remove only this browser, call authenticated
`DELETE /v1/me/push-subscriptions/{id}` and then `subscription.unsubscribe()`. Deletion is
idempotent and only affects registrations owned by the caller.

Remove the server registration while the session is still valid when logging out or switching
accounts, then unsubscribe locally. This prevents old-account appointment notifications on a
shared device. If the server removal fails, still unsubscribe locally and surface the failed
cleanup appropriately; expired subscriptions are removed after a provider `404` or `410`.
Do not reuse a previous account's registration on a new account.

The worker checks current preferences, appointment revision, caregiver authorization and
subscription ownership/keys before attempting delivery. Cancelled or rescheduled appointments
suppress obsolete reminders. An unsubscribe or preference change cannot recall a notification
already accepted by the provider. Frontends should refresh the appointment after a click.

## Verification before enabling

Exercise denied permission, unsupported browser, disabled VAPID configuration, signup/login,
opt-in, a real browser subscription, visible background delivery, same-origin click navigation,
logout/account switching, unsubscribe, key rotation and invalidated reminders. Use controlled
recipients on dev. Provider acceptance alone and API tests alone do not verify browser display;
complete a real-device check on each supported browser platform.
