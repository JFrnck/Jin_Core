import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { eq } from 'drizzle-orm';
import { google } from 'googleapis';
import type { Env } from '../../config/env.schema';
import { DB_CONNECTION, type Db } from '../../db/db.module';
import { googleOAuthTokenState } from '../../db/schema';

export type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

@Injectable()
export class GoogleOAuthService implements OnModuleInit {
  private readonly logger = new Logger(GoogleOAuthService.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly refreshToken: string;

  constructor(
    private readonly configService: ConfigService<Env, true>,
    @Inject(DB_CONNECTION) private readonly db: Db,
  ) {
    this.clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
    this.clientSecret = this.configService.get<string>('GOOGLE_CLIENT_SECRET');
    this.redirectUri = this.configService.get<string>('GOOGLE_REDIRECT_URI', {
      infer: true,
    });
    this.refreshToken = this.configService.get<string>('GOOGLE_REFRESH_TOKEN');
  }

  async onModuleInit(): Promise<void> {
    try {
      // Inicializa la fila singleton en BD si no existe aún
      const existing = await this.db
        .select()
        .from(googleOAuthTokenState)
        .where(eq(googleOAuthTokenState.id, 1));

      if (existing.length === 0) {
        await this.db.insert(googleOAuthTokenState).values({
          id: 1,
          lastRefreshedAt: new Date(),
          updatedAt: new Date(),
        });
        this.logger.log(
          'Fila de estado de Google OAuth inicializada en la base de datos.',
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `No se pudo inicializar fila de Google OAuth en BD al arrancar: ${msg}`,
      );
    }
  }

  /**
   * Retorna un cliente OAuth2 configurado con las credenciales y el refresh_token
   * del entorno.
   */
  public getOAuth2Client(): OAuth2Client {
    const oauth2Client = new google.auth.OAuth2(
      this.clientId,
      this.clientSecret,
      this.redirectUri,
    );

    oauth2Client.setCredentials({
      refresh_token: this.refreshToken,
    });

    return oauth2Client;
  }

  /**
   * Actualiza el timestamp de último refresco manual en la base de datos.
   */
  public async updateLastRefreshedAt(date: Date = new Date()): Promise<void> {
    await this.db
      .insert(googleOAuthTokenState)
      .values({
        id: 1,
        lastRefreshedAt: date,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: googleOAuthTokenState.id,
        set: {
          lastRefreshedAt: date,
          updatedAt: new Date(),
        },
      });

    this.logger.log(
      `Timestamp de refresco de Google OAuth actualizado: ${date.toISOString()}`,
    );
  }

  /**
   * Obtiene la fecha del último refresco de token guardada en BD.
   */
  public async getLastRefreshedAt(): Promise<Date> {
    const rows = await this.db
      .select()
      .from(googleOAuthTokenState)
      .where(eq(googleOAuthTokenState.id, 1));

    if (rows.length === 0 || !rows[0]) {
      return new Date();
    }

    return rows[0].lastRefreshedAt;
  }

  /**
   * Cron diario (09:00 AM local) que verifica el tiempo transcurrido desde el último
   * refresco. Si han pasado >= 6 días (24 horas antes de expirar el plazo de 7 días
   * en Testing Mode de Google OAuth), emite alertas ruidosas en logs.
   */
  @Cron('0 9 * * *')
  async checkOAuthTokenStatus(): Promise<void> {
    const lastRefreshed = await this.getLastRefreshedAt();
    const now = new Date();
    const diffMs = now.getTime() - lastRefreshed.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);

    if (diffDays >= 6) {
      this.logger.warn(
        `⚠️ ALERTA DE SEGURIDAD OAUTH: El refresh token de Google OAuth (Testing Mode) ` +
          `caducará pronto. Transcurridos ${diffDays.toFixed(1)} días desde el último refresco ` +
          `(${lastRefreshed.toISOString()}). Se requiere refresco manual del owner.`,
      );
    } else {
      this.logger.debug(
        `Google OAuth token ok. Días desde último refresco: ${diffDays.toFixed(1)}/7 días.`,
      );
    }
  }
}
