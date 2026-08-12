import { parseBody } from "@/lib/api";
import { active } from "@/lib/handler";
import { supportCompleteSchema } from "@/lib/validators";
import { verifySessionTasks } from "@/lib/services/support";

/**
 * Runs verification for a session's tasks and reports the honest result per task,
 * including the method used (YOUTUBE_API / PLATFORM_OBSERVED / SELF_REPORTED /
 * UNVERIFIED) and a reason when a check failed or could not be performed.
 *
 * The client never asserts "I subscribed" — it asks the server to check.
 */
export const POST = active(
  "support.verify",
  async ({ req, user }) => {
    const { sessionId } = await parseBody(req, supportCompleteSchema);
    const tasks = await verifySessionTasks(sessionId, user.id);

    return {
      tasks,
      allRequiredSatisfied: tasks.filter((t) => t.required).every((t) => t.satisfied),
    };
  },
  { rateLimit: "supportComplete" }
);
