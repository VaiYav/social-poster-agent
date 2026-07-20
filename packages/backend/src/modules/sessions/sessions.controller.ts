import { Controller, Get, Post, Query, HttpCode, HttpStatus, BadRequestException, ParseEnumPipe } from '@nestjs/common';
import { SocialNetwork } from '@prisma/client';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { SessionsService } from './sessions.service';

@ApiTags('sessions')
@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessionsService: SessionsService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List all browser sessions with status' })
  @ApiResponse({ status: 200, description: 'List of sessions per network' })
  async findAll() {
    return this.sessionsService.findAll();
  }

  @Post('health-check')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run health check on a session (verifies browser session is still valid)' })
  @ApiQuery({ name: 'network', required: true, enum: ['X', 'THREADS', 'FACEBOOK'] })
  @ApiQuery({ name: 'accountId', required: false, description: 'Specific account to health-check (defaults to first active for network)' })
  @ApiResponse({ status: 200, description: 'Health check result' })
  async healthCheck(
    @Query('network', new ParseEnumPipe(SocialNetwork)) network: SocialNetwork,
    @Query('accountId') accountId?: string,
  ) {
    return this.sessionsService.healthCheck(network, accountId);
  }

  @Post('verify-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit a verification/2FA code for an ongoing login attempt',
    description:
      'When X (or another network) sends a verification code via email during auto-login, ' +
      'submit it here. The login flow polls Redis for this code and enters it into the browser. ' +
      'Code expires in 5 minutes.',
  })
  @ApiQuery({ name: 'network', required: true, enum: ['X', 'THREADS', 'FACEBOOK'] })
  @ApiQuery({ name: 'code', required: true, description: 'Verification code from email/SMS' })
  @ApiResponse({ status: 200, description: 'Code stored successfully' })
  @ApiResponse({ status: 400, description: 'Missing network or code' })
  async submitVerifyCode(
    @Query('network', new ParseEnumPipe(SocialNetwork)) network: SocialNetwork,
    @Query('code') code: string,
  ) {
    if (!network || !code) {
      throw new BadRequestException('Both network and code are required');
    }
    await this.sessionsService.setVerificationCode(network, code.trim());
    return { success: true, message: `Verification code stored for ${network} — login flow will pick it up` };
  }
}
