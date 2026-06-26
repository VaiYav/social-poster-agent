import { Controller, Post, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { PostingService } from './posting.service';

@ApiTags('posting')
@Controller('posting')
export class PostingController {
  constructor(private readonly postingService: PostingService) {}

  @Post(':postId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Post a single approved post to its social network' })
  @ApiParam({ name: 'postId', type: String })
  @ApiResponse({ status: 200, description: 'Post result with success/url/error' })
  @ApiResponse({ status: 404, description: 'Post not found or not approved' })
  async postById(@Param('postId') postId: string) {
    return this.postingService.postById(postId);
  }

  @Post('batch/all-approved')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Post all approved posts in batch (with rate limiting + delays)' })
  @ApiResponse({ status: 200, description: 'Batch result with posted/failed counts' })
  async postAllApproved() {
    return this.postingService.postAllApproved();
  }
}
