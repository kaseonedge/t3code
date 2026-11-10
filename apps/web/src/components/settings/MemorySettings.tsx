import { AuthOrchestrationOperateScope, type EnvironmentId, type Memory } from "@t3tools/contracts";
import { Trash2Icon } from "lucide-react";
import { useState } from "react";

import { useThreadShells } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const KIND_LABELS: Record<Memory["kind"], string> = {
  fact: "Fact",
  preference: "Preference",
  decision: "Decision",
};

/** What the voice thread has remembered on this environment, with a way to delete each entry. */
export function MemorySettings({
  environmentId,
  environmentLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const list = useAtomCommand(serverEnvironment.listMemories, { reportFailure: false });
  const forget = useAtomCommand(serverEnvironment.forgetMemory, { reportFailure: false });
  const canForget = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const threads = useThreadShells();
  const [memories, setMemories] = useState<ReadonlyArray<Memory> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    const result = await list({ environmentId, input: {} });
    setBusy(false);
    if (result._tag === "Success") setMemories(result.value.memories);
    else setError("Couldn’t load memories. Check the connection and try again.");
  };
  const remove = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    const result = await forget({ environmentId, input: { id } });
    setBusy(false);
    if (result._tag === "Success")
      setMemories((current) => current?.filter((memory) => memory.id !== id) ?? null);
    else setError("Couldn’t delete that memory. Try again.");
  };

  return (
    <SettingsRow
      {...searchableSetting("voice-memory")}
      title="Memory"
      description={`Facts, preferences and decisions the voice thread chose to remember on ${environmentLabel}, so it can recall them in later conversations. Passwords, keys and tokens are refused.`}
      control={
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() => void load()}
        >
          {memories === null ? "Show memories" : "Refresh"}
        </Button>
      }
    >
      {error ? <p className="px-4 pb-3 text-sm text-destructive">{error}</p> : null}
      {memories !== null && memories.length === 0 ? (
        <p className="px-4 pb-3 text-sm text-muted-foreground">Nothing remembered yet.</p>
      ) : null}
      {memories !== null && memories.length > 0 ? (
        <ul className="flex flex-col gap-2 px-4 pb-3" aria-label="Memories">
          {memories.map((memory) => (
            <li key={memory.id} className="flex min-w-0 items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm break-words">{memory.text}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {KIND_LABELS[memory.kind]} · {new Date(memory.createdAt).toLocaleDateString()} ·{" "}
                  {threads.find(
                    (thread) =>
                      thread.environmentId === environmentId && thread.id === memory.threadId,
                  )?.title ?? "a thread that is no longer listed"}
                </p>
              </div>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost-destructive"
                aria-label="Delete this memory"
                disabled={busy || !canForget}
                onClick={() => void remove(memory.id)}
              >
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </SettingsRow>
  );
}
