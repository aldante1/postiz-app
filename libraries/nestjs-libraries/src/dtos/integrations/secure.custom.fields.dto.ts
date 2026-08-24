import {
  IsDefined,
  IsObject,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export const SECURE_CUSTOM_FIELDS_MAX_STATE_LENGTH = 256;
export const SECURE_CUSTOM_FIELDS_MAX_VALUES_BYTES = 8192;
export const SECURE_CUSTOM_FIELDS_MAX_VALUE_LENGTH = 4096;

export class SecureCustomFieldsDto {
  @IsString()
  @MinLength(1)
  @MaxLength(SECURE_CUSTOM_FIELDS_MAX_STATE_LENGTH)
  state: string;

  @IsDefined()
  @IsObject()
  values: Record<string, string>;
}
