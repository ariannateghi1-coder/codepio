import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/states";
import { getSessionUser, logout } from "@/lib/security";

/**
 * Shown when a signed-in account is suspended or banned. It states the status
 * plainly instead of letting the user bounce between pages that silently fail, and
 * offers a clean sign-out so the dead session doesn't linger.
 */
export default async function AccountBlockedPage() {
  const user = await getSessionUser();
  const banned = user?.status === "BANNED";

  return (
    <main id="main" className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-md text-center">
        <h1 className="mb-4 text-xl font-black">{banned ? "حساب شما مسدود شده است" : "حساب شما موقتاً معلق است"}</h1>
        <Alert tone={banned ? "danger" : "warning"}>
          {banned
            ? "دسترسی این حساب به پلتفرم مسدود شده است. اگر فکر می‌کنید اشتباهی رخ داده، با پشتیبانی تماس بگیرید."
            : "این حساب موقتاً معلق است. پس از بررسی، وضعیت آن بروزرسانی می‌شود."}
        </Alert>
        <form
          action={async () => {
            "use server";
            await logout();
          }}
          className="mt-6"
        >
          <Button type="submit" variant="outline" fullWidth>
            خروج از حساب
          </Button>
        </form>
        <Link href="/" className="mt-3 inline-block text-sm font-semibold text-accent">
          بازگشت به صفحه اصلی
        </Link>
      </div>
    </main>
  );
}
