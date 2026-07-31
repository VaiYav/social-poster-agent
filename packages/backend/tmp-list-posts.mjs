import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const posts = await prisma.post.findMany({ orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, status: true, network: true, content: true } });
console.table(posts);
await prisma.$disconnect();
