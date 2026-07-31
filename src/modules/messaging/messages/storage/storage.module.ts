import { Module, FactoryProvider } from '@nestjs/common';
import { ConfigService, ConfigModule } from '@nestjs/config';
import { STORAGE_PROVIDER, StorageProvider } from './storage.provider';
import { LocalStorageProvider } from './local-storage.provider';
import { R2StorageProvider } from './r2-storage.provider';

const storageProviderFactory: FactoryProvider<StorageProvider> = {
  provide: STORAGE_PROVIDER,
  inject: [ConfigService, LocalStorageProvider, R2StorageProvider],
  useFactory: (
    config: ConfigService,
    local: LocalStorageProvider,
    r2: R2StorageProvider,
  ): StorageProvider => {
    const hasR2 =
      !!config.get<string>('R2_ACCOUNT_ID') &&
      !!config.get<string>('R2_ACCESS_KEY_ID') &&
      !!config.get<string>('R2_BUCKET');
    return hasR2 ? r2 : local;
  },
};

@Module({
  imports: [ConfigModule],
  providers: [LocalStorageProvider, R2StorageProvider, storageProviderFactory],
  exports: [storageProviderFactory],
})
export class StorageModule {}
