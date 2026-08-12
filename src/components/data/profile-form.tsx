"use client";

import { useEffect, useState, type FormEvent } from "react";
import { api, errorMessage, fieldErrors } from "@/lib/client-api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Alert } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { Avatar } from "@/components/ui/avatar";

/**
 * Profile settings.
 *
 * The form posts only the fields the schema whitelists, so no client can smuggle
 * `role`, `credits` or `status` into the patch. Server field errors are mapped back
 * onto their inputs.
 */

type Profile = {
  username: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  bio: string | null;
  country: string | null;
  language: string;
  referralCode: string;
};

export function ProfileForm() {
  const toast = useToast();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});

  useEffect(() => {
    api
      .get<{ user: Profile }>("/api/v1/users/me")
      .then((data) => setProfile(data.user))
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSaving(true);
    setError("");
    setFields({});
    try {
      await api.patch("/api/v1/users/me", {
        name: String(form.get("name") ?? ""),
        bio: String(form.get("bio") ?? ""),
        avatarUrl: String(form.get("avatarUrl") ?? "") || null,
        country: String(form.get("country") ?? "") || null,
        language: String(form.get("language") ?? "fa"),
      });
      toast.push({ tone: "success", message: "پروفایل ذخیره شد." });
    } catch (e) {
      setError(errorMessage(e));
      setFields(fieldErrors(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="skeleton h-96 rounded-xl" />;
  if (!profile) return <Alert tone="danger">{error || "دریافت پروفایل ممکن نشد."}</Alert>;

  return (
    <Card className="p-5 sm:p-6">
      <div className="mb-5 flex items-center gap-3">
        <Avatar src={profile.avatarUrl} name={profile.name} size="lg" />
        <div>
          <p className="text-sm font-bold">{profile.name}</p>
          <p className="latin text-xs text-fg-subtle" dir="ltr">
            @{profile.username}
          </p>
        </div>
      </div>

      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && (
          <Alert tone="danger" live="alert">
            {error}
          </Alert>
        )}

        <Field label="نام" htmlFor="name" required error={fields.name}>
          <Input id="name" name="name" defaultValue={profile.name} required invalid={Boolean(fields.name)} />
        </Field>

        <Field label="بیوگرافی" htmlFor="bio" hint="حداکثر ۵۰۰ نویسه" error={fields.bio}>
          <Textarea id="bio" name="bio" defaultValue={profile.bio ?? ""} maxLength={500} invalid={Boolean(fields.bio)} />
        </Field>

        <Field label="آدرس تصویر پروفایل" htmlFor="avatarUrl" hint="فقط آدرس https" error={fields.avatarUrl}>
          <Input
            id="avatarUrl"
            name="avatarUrl"
            type="url"
            dir="ltr"
            className="latin"
            defaultValue={profile.avatarUrl ?? ""}
            invalid={Boolean(fields.avatarUrl)}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="کشور" htmlFor="country" error={fields.country}>
            <Input id="country" name="country" defaultValue={profile.country ?? ""} invalid={Boolean(fields.country)} />
          </Field>

          <Field label="زبان" htmlFor="language">
            <Select id="language" name="language" defaultValue={profile.language}>
              <option value="fa">فارسی</option>
              <option value="en">English</option>
            </Select>
          </Field>
        </div>

        <div className="rounded-lg bg-surface-sunken p-3">
          <p className="text-xs text-fg-subtle">کد دعوت شما</p>
          <p className="latin mt-1 text-sm font-bold" dir="ltr">
            {profile.referralCode}
          </p>
          <p className="mt-1.5 text-xs leading-6 text-fg-subtle">
            پاداش دعوت پس از انجام اولین حمایت تأییدشده توسط فرد دعوت‌شده پرداخت می‌شود.
          </p>
        </div>

        <Button type="submit" loading={saving}>
          ذخیره تغییرات
        </Button>
      </form>
    </Card>
  );
}
