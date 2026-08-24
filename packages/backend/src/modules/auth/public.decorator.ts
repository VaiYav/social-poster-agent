import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "isPublic";

/**
 * Mark a controller or handler as public (no JWT required).
 *
 * Consumed by the global JwtAuthGuard via Reflector.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
