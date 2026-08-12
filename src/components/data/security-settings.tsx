"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { LogOut, Monitor, ShieldCheck, Trash2 } from "lucide-react";
import { api, errorMessage, fieldErrors } from "@/lib/client-api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, PasswordInput } from "@/components/ui/field";
import { Pill } from "@/components/ui/badge";
import { Alert } from "@/components/ui/states";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { Section } from "@/components/layout/page";
import { formatRelativeTime } from "@/lib/cn";

/**
 * Security settings: password change, session management, account deactivation.
 *
 * Session list and revocation are scoped server-side to the caller's own userId,
 * so an id belonging to another account matches nothing. Deactivation is
 * confirmed through a modal because it is not silently reversible by the user.
 */

type SessionRow = {
  id: string;
  device: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
};

export function SecuritySettings() {
  const toast = useToast();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);

  const loadSessions = useCallback(async () => {
    setLoadingSessions(true);
    try {
      const data = await api.get<{ items: SessionRow[] }>("/api/v1/auth/sessions");
      setSessions(data.items);
    } catch (e) {
      toast.push({ tone: "error", message: errorMessage(e) });
    } finally {
      setLoadingSessions(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadSessions();
    // loadSessions is stable per toast identity; running once on mount is intended.
  }, [loadSessions]);

  async function revoke(sessionId: string) {
    try {
      await api.delete("/api/v1/auth/sessions", { sessionId });
      toast.push({ tone: "success", message: "نشست بسته شد." });
      await loadSessions();
    } catch (e) {
      toast.push({ tone: "error", message: errorMessage(e) });
    }
  }

  async function revokeOthers() {
    try {
      await api.delete("/api/v1/auth/sessions", { all: true });
      toast.push({ tone: "success", message: "سایر نشست‌ها بسته شدند." });
      await loadSessions();
    } catch (e) {
      toast.push({ tone: "error", message: errorMessage(e) });
    }
  }

  async function deactivate() {
    try {
      await api.delete("/api/v1/users/me");
      window.location.href = "/";
    } catch (e) {
      toast.push({ tone: "error", message: errorMessage(e) });
    }
  }

  return (
    <div>
      <Section title="تغییر رمز عبور">
        <ChangePasswordForm onDone={loadSessions} />
      </Section>

      <Section title="نشست‌های فعال" description="اگر نشستی را نمی‌شناسید، آن را ببندید و رمز عبور را تغییر دهید.">
        {loadingSessions ? (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, index) => (
              <div key={index} className="skeleton h-16 rounded-xl" />
            ))}
          </div>
        ) : (
          <>
            <ul className="space-y-2">
              {sessions.map((session) => (
                <li key={session.id}>
                  <Card className="flex-row items-center gap-3 p-3">
                    <Monitor aria-hidden size={18} className="shrink-0 text-fg-subtle" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-bold">{session.device}</p>
                        {session.current && <Pill tone="success">نشست فعلی</Pill>}
                      </div>
                      <p className="mt-0.5 text-xs text-fg-subtle">آخرین فعالیت {formatRelativeTime(session.lastSeenAt)}</p>
                    </div>
                    {!session.current && (
                      <Button variant="ghost" size="sm" onClick={() => revoke(session.id)}>
                        بستن
                      </Button>
                    )}
                  </Card>
                </li>
              ))}
            </ul>

            {sessions.length > 1 && (
              <Button variant="outline" className="mt-3" onClick={revokeOthers} icon={<LogOut aria-hidden size={15} />}>
                بستن همه نشست‌های دیگر
              </Button>
            )}
          </>
        )}
      </Section>

      <Section title="غیرفعال‌سازی حساب">
        <Card className="border-danger/30 p-5">
          <p className="text-sm leading-8 text-fg-muted">
            با غیرفعال‌سازی، حساب شما معلق می‌شود، همه نشست‌ها بسته می‌شوند و کمپین‌های فعالتان پایان می‌یابد. تاریخچه حمایت و دفتر حساب
            برای شفافیت حفظ می‌شود.
          </p>
          <Button variant="danger" className="mt-4" onClick={() => setConfirmDeactivate(true)} icon={<Trash2 aria-hidden size={15} />}>
            غیرفعال‌سازی حساب
          </Button>
        </Card>
      </Section>

      <Modal
        open={confirmDeactivate}
        onClose={() => setConfirmDeactivate(false)}
        title="غیرفعال‌سازی حساب"
        description="این عملیات حساب شما را معلق می‌کند و از سیستم خارج می‌شوید."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDeactivate(false)}>
              انصراف
            </Button>
            <Button variant="danger" onClick={deactivate}>
              تأیید و غیرفعال‌سازی
            </Button>
          </>
        }
      >
        <Alert tone="danger" title="مطمئن هستید؟">
          برای بازگشت باید با پشتیبانی تماس بگیرید.
        </Alert>
      </Modal>
    </div>
  );
}

function ChangePasswordForm({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setLoading(true);
    setError("");
    setFields({});
    try {
      await api.post("/api/v1/auth/change-password", {
        currentPassword: String(form.get("currentPassword") ?? ""),
        password: String(form.get("password") ?? ""),
        confirmPassword: String(form.get("confirmPassword") ?? ""),
      });
      formElement.reset();
      toast.push({ tone: "success", message: "رمز عبور تغییر کرد و سایر نشست‌ها بسته شدند." });
      onDone();
    } catch (e) {
      setError(errorMessage(e));
      setFields(fieldErrors(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="p-5">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && (
          <Alert tone="danger" live="alert">
            {error}
          </Alert>
        )}

        <Field label="رمز عبور فعلی" htmlFor="currentPassword" required error={fields.currentPassword}>
          <PasswordInput
            id="currentPassword"
            name="currentPassword"
            autoComplete="current-password"
            required
            invalid={Boolean(fields.currentPassword)}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="رمز عبور جدید" htmlFor="password" required hint="حداقل ۱۰ نویسه" error={fields.password}>
            <PasswordInput id="password" name="password" autoComplete="new-password" required invalid={Boolean(fields.password)} />
          </Field>
          <Field label="تکرار رمز جدید" htmlFor="confirmPassword" required error={fields.confirmPassword}>
            <PasswordInput
              id="confirmPassword"
              name="confirmPassword"
              autoComplete="new-password"
              required
              invalid={Boolean(fields.confirmPassword)}
            />
          </Field>
        </div>

        <Button type="submit" loading={loading} icon={<ShieldCheck aria-hidden size={15} />}>
          تغییر رمز عبور
        </Button>
      </form>
    </Card>
  );
}
