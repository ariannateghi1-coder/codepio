"use client";

import { useState, type FormEvent } from "react";
import { Megaphone } from "lucide-react";
import { api, errorMessage, fieldErrors } from "@/lib/client-api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Alert } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { formatNumber } from "@/lib/cn";

/**
 * Announcement broadcast.
 *
 * Recipients are written in batches server-side, so a large audience never holds a
 * single long transaction open. The confirmation reports the real number of rows
 * created rather than assuming success.
 */
export function AdminBroadcastForm() {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<number | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setLoading(true);
    setError("");
    setFields({});
    try {
      const result = await api.post<{ recipients: number }>("/api/v1/admin/notifications", {
        title: String(form.get("title") ?? ""),
        message: String(form.get("message") ?? ""),
        audience: String(form.get("audience") ?? "ACTIVE"),
      });
      setSent(result.recipients);
      formElement.reset();
      toast.push({ tone: "success", message: `اعلان برای ${formatNumber(result.recipients)} کاربر ارسال شد.` });
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

        {sent !== null && (
          <Alert tone="success" live="status">
            آخرین اعلان برای <span className="numeric">{formatNumber(sent)}</span> کاربر ثبت شد.
          </Alert>
        )}

        <Field label="مخاطب" htmlFor="audience" required>
          <Select id="audience" name="audience" defaultValue="ACTIVE">
            <option value="ACTIVE">کاربران فعال</option>
            <option value="ALL">همه کاربران</option>
            <option value="STAFF">تیم مدیریت</option>
          </Select>
        </Field>

        <Field label="عنوان" htmlFor="title" required error={fields.title}>
          <Input id="title" name="title" required minLength={3} maxLength={120} invalid={Boolean(fields.title)} />
        </Field>

        <Field label="متن اعلان" htmlFor="message" required error={fields.message}>
          <Textarea id="message" name="message" required minLength={3} maxLength={1000} invalid={Boolean(fields.message)} />
        </Field>

        <Button type="submit" loading={loading} icon={<Megaphone aria-hidden size={15} />}>
          ارسال اعلان
        </Button>
      </form>
    </Card>
  );
}
