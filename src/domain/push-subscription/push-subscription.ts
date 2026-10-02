export type PushSubscription = {
  readonly id: string;
  readonly userId: string;
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
};
