"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/client-api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Pill } from "@/components/ui/badge";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { formatNumber, formatDateTime } from "@/lib/cn";

/**
 * Audit log viewer.
 *
 * Read-only. The stored records contain hashed IPs and structured metadata only —
 * no passwords, tokens or raw addresses — so displaying them here is safe.
 */

type AuditRow = {
  id: string;
  action: string;
  entity: string | null;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  user: { username: string; name: string; role: string } | null;
};

const ACTIONS = [
  "",
  "LOGIN",
  "LOGOUT",
  "CREATE",
  "UPDATE",
  "DELETE",
  "SUPPORT",
  "SUPPORT_REVERSAL",
  "ADMIN_ACTION",
  "SECURITY",
  "LEDGER_ADJUSTMENT",
  "NOTIFICATION",
] as const;

export function AdminAuditTable() {
  const [items, setItems] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [action, setAction] = useState("");
  const [entity, setEntity] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ page: String(page), limit: "50" });
    if (action) params.set("action", action);
    if (entity) params.set("entity", entity);
    try {
      const data = await api.get<{ items: AuditRow[]; total: number }>(`/api/v1/admin/audit?${params.toString()}`);
      setItems(data.items);
      setTotal(data.total);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [page, action, entity]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / 50));

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row">
        <Select
          value={action}
          onChange={(event) => {
            setAction(event.target.value);
            setPage(1);
          }}
          aria-label="فیلتر نوع عملیات"
          className="sm:w-56"
        >
          {ACTIONS.map((value) => (
            <option key={value || "all"} value={value}>
              {value || "همه عملیات"}
            </option>
          ))}
        </Select>
        <Input
          value={entity}
          onChange={(event) => {
            setEntity(event.target.value);
            setPage(1);
          }}
          placeholder="فیلتر موجودیت (مثلاً Support)"
          aria-label="فیلتر موجودیت"
          dir="ltr"
          className="latin flex-1"
        />
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : loading ? (
        <div className="space-y-1.5">
          {Array.from({ length: 10 }).map((_, index) => (
            <div key={index} className="skeleton h-12 rounded-lg" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState variant="no-results" title="رکوردی یافت نشد" description="فیلترها را تغییر دهید." />
      ) : (
        <>
          <p role="status" className="mb-3 text-xs text-fg-subtle">
            <span className="numeric">{formatNumber(total)}</span> رکورد
          </p>
          <ul className="space-y-1.5">
            {items.map((row) => (
              <li key={row.id}>
                <Card className="p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone={row.action.includes("SECURITY") || row.action.includes("REVERSAL") ? "warning" : "neutral"}>
                      <span className="latin" dir="ltr">
                        {row.action}
                      </span>
                    </Pill>
                    {row.entity && (
                      <span className="latin text-xs text-fg-muted" dir="ltr">
                        {row.entity}
                        {row.entityId ? `#${row.entityId.slice(0, 8)}` : ""}
                      </span>
                    )}
                    {row.user && (
                      <span className="latin text-xs text-fg-subtle" dir="ltr">
                        @{row.user.username}
                      </span>
                    )}
                    <time className="ms-auto text-[0.6875rem] text-fg-subtle" dateTime={row.createdAt}>
                      {formatDateTime(row.createdAt)}
                    </time>
                  </div>
                  {row.metadata && Object.keys(row.metadata).length > 0 && (
                    <pre
                      dir="ltr"
                      className="latin mt-2 max-h-24 overflow-auto rounded-md bg-surface-sunken p-2 text-[0.625rem] leading-5 text-fg-muted"
                    >
                      {JSON.stringify(row.metadata)}
                    </pre>
                  )}
                </Card>
              </li>
            ))}
          </ul>

          {totalPages > 1 && (
            <nav aria-label="صفحه‌بندی" className="mt-5 flex items-center justify-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                قبلی
              </Button>
              <span className="numeric text-sm text-fg-muted">
                {formatNumber(page)} از {formatNumber(totalPages)}
              </span>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                بعدی
              </Button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}
