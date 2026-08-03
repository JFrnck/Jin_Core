import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { ChainVerificationService } from './chain-verification.service';

@Module({
  controllers: [AuditController],
  providers: [AuditService, ChainVerificationService],
  exports: [AuditService, ChainVerificationService],
})
export class AuditModule {}
