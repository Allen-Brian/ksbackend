import { z } from "@hono/zod-openapi";

const relationship = z.enum(["child", "parent", "spouse", "sibling", "other"]);

export const InviteBody = z
  .object({
    inviteeEmail: z.email(),
    relationship,
  })
  .openapi("InviteDependent");

const linkView = z.object({
  id: z.uuid(),
  caregiverUserId: z.string(),
  subjectUserId: z.string().nullable(),
  inviteIdentifier: z.string().nullable(),
  relationship,
  status: z.enum(["pending", "active", "revoked", "declined"]),
  direction: z.enum(["sent", "received"]),
});

export const LinkResponse = linkView.openapi("CaregiverLink");

export const LinksResponse = z.object({ links: z.array(linkView) }).openapi("CaregiverLinks");

export const TokenParam = z.object({ token: z.string().min(1) });
export const LinkIdParam = z.object({ id: z.uuid() });

export const UserSearchQuery = z.object({ email: z.email() });
export const UserSearchResponse = z
  .object({ user: z.object({ userId: z.string(), displayName: z.string() }).nullable() })
  .openapi("UserSearchResult");
