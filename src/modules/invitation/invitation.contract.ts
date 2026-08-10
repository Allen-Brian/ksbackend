import { z } from "@hono/zod-openapi";
import { paginated } from "@/http/schemas";

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

export const LinksPage = paginated(linkView).openapi("CaregiverLinksPage");

export const TokenParam = z.object({ token: z.string().min(1) });
export const LinkIdParam = z.object({ id: z.uuid() });

export const UserSearchQuery = z.object({ email: z.email() });
// Existence only — no name/userId — to avoid enumeration + PII disclosure.
// Names become mutually visible after an invite is accepted.
export const UserSearchResponse = z.object({ exists: z.boolean() }).openapi("UserSearchResult");
