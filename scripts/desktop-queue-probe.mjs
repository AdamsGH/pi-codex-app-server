import { pathToFileURL } from "node:url";

/**
 * @param {{hostId: string, threadId: string}} options Target host and thread.
 * @param {{performance: {getEntriesByType: (type: string) => {name: string}[]}, document: {querySelectorAll: (selector: string) => Iterable<object>}, loadModule?: (url: string) => object | Promise<object>}} runtime Browser APIs or synthetic fixtures.
 */
export const collectDesktopQueueState = async (
  options,
  runtime = globalThis
) => {
  const resource = runtime.performance
    .getEntriesByType("resource")
    .find((entry) => entry.name.endsWith("/app-shared-30671c57ec82.js"));
  if (!resource) {
    throw new Error(
      "Unsupported desktop bundle. Refresh the probe from installed desktop source."
    );
  }
  const module = await (runtime.loadModule ?? ((url) => import(url)))(
    resource.name
  );
  // eslint-disable-next-line unicorn/consistent-function-scoping -- Nested helpers must remain inside the serialized DevTools function.
  const storesForFiber = (fiber) => {
    const props = fiber.memoizedProps;
    const candidates = [props?.value, props?.store, props?.value?.store];
    for (
      let count = 0, hook = fiber.memoizedState;
      hook && count < 100;
      hook = hook.next, count += 1
    ) {
      candidates.push(
        hook.memoizedState?.current,
        hook.memoizedState?.current?.store
      );
    }
    return candidates;
  };
  const findRegistry = () => {
    const seen = new Set();
    const pending = [];
    for (const node of runtime.document.querySelectorAll("*")) {
      for (const key of Object.keys(node)) {
        if (
          key.startsWith("__reactFiber$") ||
          key.startsWith("__reactContainer$")
        ) {
          pending.push(node[key]);
        }
      }
    }
    let registry;
    while (pending.length > 0 && seen.size < 100_000 && !registry) {
      const fiber = pending.pop();
      if (!fiber || seen.has(fiber)) {
        continue;
      }
      seen.add(fiber);
      pending.push(fiber.child, fiber.sibling, fiber.return);
      const candidates = storesForFiber(fiber);
      for (const store of candidates) {
        if (!store?.get || !store?.set) {
          continue;
        }
        try {
          const value = store.get(module.v$t);
          if (value?.forHost) {
            registry = value;
            break;
          }
        } catch {
          // Other React providers can expose unrelated stores.
        }
      }
    }
    return registry;
  };
  const registry = findRegistry();
  if (!registry) {
    throw new Error("Desktop manager store not found. No state was changed.");
  }
  const manager = registry.forHost(options.hostId);
  const deadline = Promise.withResolvers();
  const timer = setTimeout(
    () => deadline.reject(new Error("Desktop manager read timed out")),
    10_000
  );
  let result;
  try {
    result = await Promise.race([
      Promise.all([
        manager.getConversation(options.threadId),
        manager.getStreamRole(options.threadId),
      ]),
      deadline.promise,
    ]);
  } finally {
    clearTimeout(timer);
  }
  const [conversation, role] = result;
  if (!conversation) {
    throw new Error("Thread is absent from the desktop manager cache.");
  }
  const turns =
    conversation.turnHistory?.kind === "canonical"
      ? Object.values(conversation.turnHistory.history.entitiesByKey)
      : conversation.turns;
  return {
    resumeState: conversation.resumeState,
    role: { ownerClientId: role?.ownerClientId, role: role?.role },
    runtimeStatus: {
      activeFlags: conversation.threadRuntimeStatus?.activeFlags,
      type: conversation.threadRuntimeStatus?.type,
    },
    threadId: options.threadId,
    turns: turns.slice(-10).map((turn) => ({
      clientUserMessageId: turn.params?.clientUserMessageId,
      itemTypes: turn.items.map((item) => item.type),
      status: turn.status,
      turnId: turn.turnId,
      userMessages: turn.items
        .filter((item) => item.type === "userMessage")
        .map((item) => ({ clientId: item.clientId, id: item.id })),
    })),
    unconfirmed: (conversation.unconfirmedTurnSubmissions ?? []).map(
      (entry) => ({
        clientUserMessageId: entry.clientUserMessageId,
        requestId: entry.requestId,
        terminal: entry.terminal,
      })
    ),
  };
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [hostId, threadId] = process.argv.slice(2);
  if (!(hostId && threadId)) {
    throw new Error(
      "Usage: node scripts/desktop-queue-probe.mjs <host-id> <thread-id>"
    );
  }
  process.stdout.write(
    `(${collectDesktopQueueState.toString()})(${JSON.stringify({ hostId, threadId })}).then(report => console.log(JSON.stringify(report)))\n`
  );
}
