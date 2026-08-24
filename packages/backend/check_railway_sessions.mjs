import { PrismaClient } from './src/generated/prisma/client';

const prisma = new PrismaClient({
  datasources: { db: { url: 'postgresql://postgres:kFZMQFFtNTMYjVZItkWIeZjttqlLUGze@postgres.railway.internal:5432/railway' } },
});

const sessions = await prisma.session.findMany({ take: 5, select: { id: true, accountId: true, status: true, storageState: true } });
for (const s of sessions) {
  const stateStr = typeof s.storageState === 'string' ? s.storageState : JSON.stringify(s.storageState);
  console.log(s.id, s.status, stateStr.substring(0, 120));
}
await prisma.$disconnect();
