import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main id="main" className="grid min-h-dvh place-items-center px-4 text-center">
      <div>
        <p className="numeric text-5xl font-black text-accent">۴۰۴</p>
        <h1 className="mt-3 text-xl font-black">این صفحه پیدا نشد</h1>
        <p className="mt-2 text-sm leading-8 text-fg-muted">ممکن است آدرس تغییر کرده یا محتوا حذف شده باشد.</p>
        <div className="mt-6 flex justify-center gap-2">
          <Link href="/explore">
            <Button>رفتن به کاوش</Button>
          </Link>
          <Link href="/">
            <Button variant="outline">صفحه اصلی</Button>
          </Link>
        </div>
      </div>
    </main>
  );
}
