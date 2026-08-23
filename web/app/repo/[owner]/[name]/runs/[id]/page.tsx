// Pre-v2 route: runs became Reviews in the UI. Permanent redirect.

import { redirect } from "next/navigation";

export default async function LegacyRunPage({
  params,
}: {
  params: Promise<{ owner: string; name: string; id: string }>;
}) {
  const { owner, name, id } = await params;
  redirect(`/repo/${owner}/${name}/reviews/${id}`);
}
