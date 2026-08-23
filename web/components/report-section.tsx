"use client";

// Report tab (wireframe screen 11): Diagnosis, the PR comment as it lands on
// GitHub, and the machine-readable fix context.

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import remarkBreaks from "remark-breaks";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { Report } from "@/lib/types";

export function ReportSection({ report }: { report: Report }) {
  const [fixOpen, setFixOpen] = useState(false);
  const inv = report.investigation;
  return (
    <div className="space-y-3">
      {inv?.diagnosis && (
        <div className="rounded-xl border border-border-soft px-4 py-3">
          <p className="flex items-center gap-2 text-xs font-medium">
            Diagnosis
            {inv.diagnosis.confidence && (
              <Badge variant="outline" className="rounded-full text-[12px] text-muted-foreground">
                {inv.diagnosis.confidence} confidence
              </Badge>
            )}
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {inv.diagnosis.text}
          </p>
        </div>
      )}

      <div className="rounded-xl border border-border-soft px-4 py-3">
        <p className="text-xs font-medium">PR comment</p>
        <div className="mt-2 rounded-lg border border-border-soft bg-surface p-4">
          <div className="pr-md">
            {/* GitHub comment semantics: raw <details> allowed, soft breaks hard */}
            <ReactMarkdown rehypePlugins={[rehypeRaw]} remarkPlugins={[remarkBreaks]}>
              {report.pr_comment_md}
            </ReactMarkdown>
          </div>
        </div>
        <div className="mt-2 flex justify-end">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              navigator.clipboard.writeText(report.pr_comment_md);
              toast("Copied");
            }}
          >
            Copy markdown
          </Button>
        </div>
      </div>

      {inv?.fix_context && (
        <Collapsible open={fixOpen} onOpenChange={setFixOpen}>
          <div className="rounded-xl border border-border-soft px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-medium">
                fix_context.json{" "}
                <span className="font-normal text-faint">
                  — for the coding agent
                </span>
              </p>
              <CollapsibleTrigger
                render={
                  <Button size="sm" variant="outline">
                    {fixOpen ? "Collapse" : "Expand"}
                  </Button>
                }
              />
            </div>
            <CollapsibleContent>
              <pre className="mt-2 overflow-x-auto rounded-lg border border-border-soft bg-surface p-3 font-mono text-[13px] leading-relaxed text-muted-foreground">
                {JSON.stringify(inv.fix_context, null, 2)}
              </pre>
            </CollapsibleContent>
          </div>
        </Collapsible>
      )}
    </div>
  );
}
