import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { AuthModule } from '../auth/auth.module';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';

@Module({
  imports: [AgentModule, AuthModule],
  controllers: [ChatController],
  providers: [ChatGateway],
})
export class ChatModule {}
