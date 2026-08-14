"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { api, errorMessage, fieldErrors } from "@/lib/client-api";
import { Button } from "@/components/ui/button";
import { Field, Input, PasswordInput } from "@/components/ui/field";
import { Alert } from "@/components/ui/states";

/**
 * Password recovery forms.
 *
 * Both follow the same pattern as the login/register forms: a real <form>, native
 * input types, autocomplete tokens password managers understand, and server field
 * errors rendered next to the offending input.
 *
 * The one deliberate difference is what happens on success. ForgotPasswordForm
 * replaces itself with a confirmation that is identical whether or not the address
 * exists — the UI must not undo the server's anti-enumeration guarantee by, say,
 * only showing the panel when an account was found.
 */

function useFormState() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});

  async function run(action: () => Promise<void>) {
    setLoading(true);
    setError("");
    setFields({});
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
      setFields(fieldErrors(e));
    } finally {
      setLoading(false);
    }
  }

  return { loading, error, fields, run };
}

export function ForgotPasswordForm() {
  const { loading, error, fields, run } = useFormState();
  const [sent, setSent] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(async () => {
      await api.post("/api/v1/auth/forgot-password", {
        email: String(form.get("email") ?? ""),
      });
      setSent(true);
    });
  }

  if (sent) {
    return (
      <div className="space-y-4">
        <Alert tone="success" live="status" title="پیوند بازیابی ارسال شد">
          اگر این ایمیل در سامانه ثبت شده باشد، پیوند بازیابی برای آن ارسال می‌شود. صندوق ورودی و پوشه اسپم را بررسی
          کنید. پیوند ۳۰ دقیقه اعتبار دارد.
        </Alert>
        <Link href="/auth/login">
          <Button variant="outline" fullWidth>
            بازگشت به ورود
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {error && (
        <Alert tone="danger" live="alert">
          {error}
        </Alert>
      )}

      <Field label="ایمیل" htmlFor="email" required hint="همان ایمیلی که با آن ثبت‌نام کرده‌اید" error={fields.email}>
        <Input
          id="email"
          name="email"
          type="email"
          dir="ltr"
          className="latin"
          autoComplete="email"
          required
          invalid={Boolean(fields.email)}
        />
      </Field>

      <Button type="submit" fullWidth loading={loading}>
        ارسال پیوند بازیابی
      </Button>
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const { loading, error, fields, run } = useFormState();
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(async () => {
      await api.post("/api/v1/auth/reset-password", {
        token,
        password: String(form.get("password") ?? ""),
        confirmPassword: String(form.get("confirmPassword") ?? ""),
      });
      setDone(true);
      // Every session was revoked server-side, so the only correct next step is a
      // fresh sign-in. Refresh first so no stale authenticated shell is rendered.
      router.refresh();
    });
  }

  if (done) {
    return (
      <div className="space-y-4">
        <Alert tone="success" live="status" title="رمز عبور تغییر کرد">
          همه نشست‌های قبلی بسته شدند. با رمز جدید وارد شوید.
        </Alert>
        <Link href="/auth/login">
          <Button fullWidth>ورود با رمز جدید</Button>
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {error && (
        <Alert tone="danger" live="alert">
          {error}
        </Alert>
      )}

      {/* The token travels in the JSON body, not as a form field the user can see
          or a password manager can capture. */}
      <Field label="رمز عبور جدید" htmlFor="password" required hint="حداقل ۱۰ نویسه" error={fields.password}>
        <PasswordInput
          id="password"
          name="password"
          autoComplete="new-password"
          required
          invalid={Boolean(fields.password)}
        />
      </Field>

      <Field label="تکرار رمز عبور جدید" htmlFor="confirmPassword" required error={fields.confirmPassword}>
        <PasswordInput
          id="confirmPassword"
          name="confirmPassword"
          autoComplete="new-password"
          required
          invalid={Boolean(fields.confirmPassword)}
        />
      </Field>

      <Button type="submit" fullWidth loading={loading}>
        ثبت رمز عبور جدید
      </Button>
    </form>
  );
}
