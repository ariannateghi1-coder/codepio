"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { api, errorMessage, fieldErrors } from "@/lib/client-api";
import { Button } from "@/components/ui/button";
import { Field, Input, PasswordInput } from "@/components/ui/field";
import { Alert } from "@/components/ui/states";
import { safeNextPath } from "@/lib/redirect";

/**
 * Auth forms.
 *
 * Native form semantics throughout: a real <form> with a submit button so Enter
 * submits, `type="email"` / `type="password"` inputs with the autocomplete tokens
 * password managers rely on (`username`, `current-password`, `new-password`), and
 * every field wired to its label and error message.
 *
 * Server validation errors arrive with field paths, so messages appear next to the
 * offending input instead of only as a banner.
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

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { loading, error, fields, run } = useFormState();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(async () => {
      await api.post("/api/v1/auth/login", {
        emailOrUsername: String(form.get("emailOrUsername") ?? ""),
        password: String(form.get("password") ?? ""),
      });
      // Only internal paths are honoured, so ?next= can't become an open redirect.
      router.push(safeNextPath(searchParams.get("next")) ?? "/explore");
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {error && (
        <Alert tone="danger" live="alert">
          {error}
        </Alert>
      )}

      <Field label="ایمیل یا نام کاربری" htmlFor="emailOrUsername" required error={fields.emailOrUsername}>
        <Input
          id="emailOrUsername"
          name="emailOrUsername"
          autoComplete="username"
          dir="ltr"
          className="latin"
          required
          invalid={Boolean(fields.emailOrUsername)}
        />
      </Field>

      <Field label="رمز عبور" htmlFor="password" required error={fields.password}>
        <PasswordInput id="password" name="password" autoComplete="current-password" required invalid={Boolean(fields.password)} />
      </Field>

      <Button type="submit" fullWidth loading={loading}>
        ورود
      </Button>
    </form>
  );
}

export function RegisterForm() {
  const router = useRouter();
  const { loading, error, fields, run } = useFormState();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(async () => {
      await api.post("/api/v1/auth/register", {
        name: String(form.get("name") ?? ""),
        username: String(form.get("username") ?? ""),
        email: String(form.get("email") ?? ""),
        password: String(form.get("password") ?? ""),
        confirmPassword: String(form.get("confirmPassword") ?? ""),
        referralCode: String(form.get("referralCode") ?? ""),
      });

      router.push("/explore");
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
      {error && (
        <Alert tone="danger" live="alert" className="sm:col-span-2">
          {error}
        </Alert>
      )}

      <Field label="نام" htmlFor="name" required error={fields.name}>
        <Input id="name" name="name" autoComplete="name" required invalid={Boolean(fields.name)} />
      </Field>

      <Field
        label="نام کاربری"
        htmlFor="username"
        required
        hint="حروف کوچک انگلیسی، عدد و _"
        error={fields.username}
      >
        <Input
          id="username"
          name="username"
          dir="ltr"
          className="latin"
          autoComplete="username"
          pattern="[a-zA-Z0-9_]+"
          required
          invalid={Boolean(fields.username)}
        />
      </Field>

      <Field label="ایمیل" htmlFor="email" required error={fields.email} className="sm:col-span-2">
        <Input id="email" name="email" type="email" dir="ltr" className="latin" autoComplete="email" required invalid={Boolean(fields.email)} />
      </Field>

      <Field label="رمز عبور" htmlFor="password" required hint="حداقل ۱۰ نویسه" error={fields.password}>
        <PasswordInput id="password" name="password" autoComplete="new-password" required invalid={Boolean(fields.password)} />
      </Field>

      <Field label="تکرار رمز عبور" htmlFor="confirmPassword" required error={fields.confirmPassword}>
        <PasswordInput id="confirmPassword" name="confirmPassword" autoComplete="new-password" required invalid={Boolean(fields.confirmPassword)} />
      </Field>

      <Field label="کد دعوت (اختیاری)" htmlFor="referralCode" error={fields.referralCode} className="sm:col-span-2">
        <Input id="referralCode" name="referralCode" dir="ltr" className="latin" invalid={Boolean(fields.referralCode)} />
      </Field>

      <Button type="submit" fullWidth loading={loading} className="sm:col-span-2">
        ساخت حساب
      </Button>
    </form>
  );
}
