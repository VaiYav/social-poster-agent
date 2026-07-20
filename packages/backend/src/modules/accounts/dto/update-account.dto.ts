import { IsBoolean, IsInt, IsOptional, IsString, IsUUID } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateAccountDto {
  @IsOptional()
  @IsString()
  displayName?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  priority?: number;

  @IsOptional()
  @IsUUID()
  groupId?: string | null;

  @IsOptional()
  @IsString()
  proxyUrl?: string | null;

  @IsOptional()
  @IsString()
  fingerprintSeed?: string | null;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  active?: boolean;
}
