/**
 * Diagnostic script — check raw storageState in the DB.
 * Run inside Railway: railway run --service spa-backend -- npx tsx packages/backend/scripts/diag-sessions.ts
 */
import { PrismaClient } from "../src/generated/prisma/client";

const prisma = new PrismaClient();

async function main() {
  const sessions = await prisma.session.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, accountId: true, storageState: true },
  });

  console.log(`Found ${sessions.length} active sessions\n`);

  for (const s of sessions) {
    const raw = s.storageState;
    const type = typeof raw;
    const str = type === "string" ? raw : JSON.stringify(raw);
    console.log(`Session ${s.id}`);
    console.log(`  type: ${type}`);
    console.log(`  prefix: ${str.substring(0, 80)}`);
    console.log(`  length: ${str.length}`);
    console.log(`  starts with v1: ${str.startsWith("v1:")}`);
    console.log("");
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
