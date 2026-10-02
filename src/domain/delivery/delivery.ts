export type DeliverySnapshot = {
  readonly appointmentId: string;
  readonly revision: number;
  readonly event: "confirmed" | "cancelled" | "rescheduled" | "reminder";
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timezone: string;
  readonly consultationType: string;
  readonly previousStartsAt?: string | undefined;
  readonly reminderOffset?: number | undefined;
  readonly pushSubscription?:
    | {
        readonly id: string;
        readonly userId: string;
        readonly endpoint: string;
        readonly keys: { readonly p256dh: string; readonly auth: string };
      }
    | undefined;
};
export type FrozenDelivery = {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
};

export const reminderDeadlines = (
  startsAt: Date,
  now: Date,
  graceMinutes = 15,
): ReadonlyArray<{
  readonly offset: number;
  readonly dueAt: Date;
  readonly expiresAt: Date;
}> =>
  [24, 1].flatMap((offset) => {
    const due = startsAt.getTime() - offset * 3_600_000;
    return due <= now.getTime()
      ? []
      : [
          {
            offset,
            dueAt: new Date(due),
            expiresAt: new Date(Math.min(due + graceMinutes * 60_000, startsAt.getTime())),
          },
        ];
  });

export const retryDelayMillis = (attempts: number): number =>
  Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempts, 10));
