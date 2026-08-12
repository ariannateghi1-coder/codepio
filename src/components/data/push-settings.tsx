"use client";

import { useCallback, useEffect, useState } from "react";
import { BellRing, BellOff } from "lucide-react";
import { api, errorMessage } from "@/lib/client-api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { formatNumber } from "@/lib/cn";

/**
 * Browser push notifications.
 *
 * Permission is only requested in response to an explicit click — never on load,
 * which browsers penalise and users reject. The endpoint is registered
 * server-side against the current account, and unsubscribing removes both the
 * browser subscription and the stored row.
 */

type Status = { enabled: boolean; publicKey: string | null; subscriptions: number };

function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(normalized);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

export function PushSettings() {
  const toast = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api.get<Status>("/api/v1/push/subscribe"));
    } catch (e) {
      toast.push({ tone: "error", message: errorMessage(e) });
    }
  }, [toast]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setPermission("unsupported");
    } else {
      setPermission(Notification.permission);
    }
    void load();
  }, [load]);

  async function enable() {
    if (!status?.publicKey) return;
    setBusy(true);
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") {
        toast.push({ tone: "warning", message: "اجازه نمایش اعلان داده نشد." });
        return;
      }

      const registration = await navigator.serviceWorker.register("/sw.js");
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(status.publicKey),
      });

      const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
      await api.post("/api/v1/push/subscribe", {
        endpoint: json.endpoint,
        keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
      });

      toast.push({ tone: "success", message: "اعلان مرورگر فعال شد." });
      await load();
    } catch (e) {
      toast.push({ tone: "error", message: errorMessage(e, "فعال‌سازی اعلان ممکن نشد.") });
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await api.delete("/api/v1/push/subscribe", { endpoint: subscription.endpoint });
        await subscription.unsubscribe();
      }
      toast.push({ tone: "success", message: "اعلان مرورگر غیرفعال شد." });
      await load();
    } catch (e) {
      toast.push({ tone: "error", message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  if (permission === "unsupported") {
    return <Alert tone="info">مرورگر شما از اعلان‌های وب پشتیبانی نمی‌کند.</Alert>;
  }

  if (status && !status.enabled) {
    return <Alert tone="info">اعلان مرورگر روی این سرور پیکربندی نشده است.</Alert>;
  }

  return (
    <Card className="p-5">
      <h2 className="text-sm font-bold">اعلان مرورگر</h2>
      <p className="mt-1.5 text-sm leading-8 text-fg-muted">
        با فعال‌سازی، هنگام دریافت حمایت یا رویدادهای مهم حساب، اعلان مرورگر دریافت می‌کنید.
      </p>

      {status && status.subscriptions > 0 && (
        <p className="numeric mt-2 text-xs text-fg-subtle">فعال روی {formatNumber(status.subscriptions)} دستگاه</p>
      )}

      {permission === "denied" && (
        <Alert tone="warning" className="mt-4">
          اجازه اعلان در تنظیمات مرورگر مسدود شده است. برای فعال‌سازی، ابتدا آن را از تنظیمات سایت مجاز کنید.
        </Alert>
      )}

      <div className="mt-4 flex gap-2">
        <Button onClick={enable} loading={busy} disabled={permission === "denied"} icon={<BellRing aria-hidden size={15} />}>
          فعال‌سازی
        </Button>
        <Button variant="outline" onClick={disable} loading={busy} icon={<BellOff aria-hidden size={15} />}>
          غیرفعال‌سازی
        </Button>
      </div>
    </Card>
  );
}
