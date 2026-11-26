/**
 * @file stealify-schema-shim.mts
 * @description Self-contained, zero-dependency, erasable-syntax TypeScript shim
 * for `@awesome-os/stealify-schema` primitives used by `b8g-game-engine` and
 * `asymmetric-hunt` inside the standalone `awesome-os/devtools` monorepo.
 */

export type PrimitiveType =
  | 'string'
  | 'number'
  | 'float64'
  | 'int32'
  | 'boolean'
  | 'uuid'
  | 'timestamp'
  | 'array'
  | 'record'
  | 'object';

export interface FieldOptions<T = unknown> {
  type: PrimitiveType;
  primaryKey?: boolean;
  indexed?: boolean;
  nullable?: boolean;
  optional?: boolean;
  precision?: number;
  maxBytes?: number;
  items?: FieldDef<unknown> | PrimitiveType;
  recordValueType?: FieldDef<unknown> | PrimitiveType;
  validator?: (val: T) => boolean | string;
  default?: T | (() => T);
  defaultValue?: T | (() => T);
}

export class FieldDef<T = unknown> {
  public readonly type: PrimitiveType;
  public isPrimaryKey: boolean;
  public isIndexed: boolean;
  public isNullable: boolean;
  public isOptional: boolean;
  public precisionVal: number | undefined;
  public maxBytesVal: number | undefined;
  public itemsDef: FieldDef<unknown> | PrimitiveType | undefined;
  public recordValueDef: FieldDef<unknown> | PrimitiveType | undefined;
  public validatorFn: ((val: T) => boolean | string) | undefined;
  public defaultValue: T | (() => T) | undefined;

  public readonly _type!: T;

  public constructor(opts: FieldOptions<T>) {
    this.type = opts.type;
    this.isPrimaryKey = opts.primaryKey ?? false;
    this.isIndexed = opts.indexed ?? false;
    this.isNullable = opts.nullable ?? false;
    this.isOptional = opts.optional ?? false;
    this.precisionVal = opts.precision;
    this.maxBytesVal = opts.maxBytes;
    this.itemsDef = opts.items;
    this.recordValueDef = opts.recordValueType;
    this.validatorFn = opts.validator;
    this.defaultValue = opts.defaultValue ?? opts.default;
  }

  public primaryKey(): this {
    this.isPrimaryKey = true;
    this.isIndexed = true;
    return this;
  }

  public indexed(): this {
    this.isIndexed = true;
    return this;
  }

  public nullable(): FieldDef<T | null> {
    this.isNullable = true;
    return this as unknown as FieldDef<T | null>;
  }

  public optional(): FieldDef<T | undefined> {
    this.isOptional = true;
    return this as unknown as FieldDef<T | undefined>;
  }

  public precision(prec: number): this {
    this.precisionVal = prec;
    return this;
  }

  public maxBytes(bytes: number): this {
    this.maxBytesVal = bytes;
    return this;
  }

  public validate(fn: (val: T) => boolean | string): this {
    this.validatorFn = fn;
    return this;
  }

  public default(val: T | (() => T)): this {
    this.defaultValue = val;
    return this;
  }
}

export const f = {
  string: (opts?: Partial<FieldOptions<string>>): FieldDef<string> =>
    new FieldDef<string>({ type: 'string', ...opts }),
  number: (opts?: Partial<FieldOptions<number>>): FieldDef<number> =>
    new FieldDef<number>({ type: 'number', ...opts }),
  float64: (opts?: Partial<FieldOptions<number>>): FieldDef<number> =>
    new FieldDef<number>({ type: 'float64', precision: 8, ...opts }),
  int32: (opts?: Partial<FieldOptions<number>>): FieldDef<number> =>
    new FieldDef<number>({ type: 'int32', precision: 4, ...opts }),
  boolean: (opts?: Partial<FieldOptions<boolean>>): FieldDef<boolean> =>
    new FieldDef<boolean>({ type: 'boolean', ...opts }),
  uuid: (opts?: Partial<FieldOptions<string>>): FieldDef<string> =>
    new FieldDef<string>({ type: 'uuid', maxBytes: 36, ...opts }),
  timestamp: (opts?: Partial<FieldOptions<number>>): FieldDef<number> =>
    new FieldDef<number>({ type: 'timestamp', precision: 8, ...opts }),
  array: <TItem>(
    items: FieldDef<TItem> | PrimitiveType,
    opts?: Partial<FieldOptions<TItem[]>>,
  ): FieldDef<TItem[]> =>
    new FieldDef<TItem[]>({
      type: 'array',
      items: items as FieldDef<unknown> | PrimitiveType,
      ...opts,
    }),
  record: <TVal>(
    _key: 'string',
    valueType: FieldDef<TVal> | PrimitiveType,
    opts?: Partial<FieldOptions<Record<string, TVal>>>,
  ): FieldDef<Record<string, TVal>> =>
    new FieldDef<Record<string, TVal>>({
      type: 'record',
      recordValueType: valueType as FieldDef<unknown> | PrimitiveType,
      ...opts,
    }),
  object: <TObj extends Record<string, unknown>>(
    opts?: Partial<FieldOptions<TObj>>,
  ): FieldDef<TObj> => new FieldDef<TObj>({ type: 'object', ...opts }),
};

export interface ProtocolBinding {
  readonly direction: 'input' | 'output';
  readonly protocol: string;
  readonly target: string;
}

export const p = {
  input: (protocol: string, target: string): ProtocolBinding => ({
    direction: 'input',
    protocol,
    target,
  }),
  output: (protocol: string, target: string): ProtocolBinding => ({
    direction: 'output',
    protocol,
    target,
  }),
};

export interface SubstrateDescriptor {
  readonly kind: string;
  readonly target?: string;
  readonly table?: string;
  readonly ringBytes?: number;
  readonly watch?: boolean;
}

export const s = {
  disk: (opts: { root?: string; watch?: boolean } = {}): SubstrateDescriptor => ({
    kind: 'disk',
    target: opts.root ?? '.',
    watch: opts.watch ?? true,
  }),
  uvsCas: (opts: { prefix?: string } = {}): SubstrateDescriptor => ({
    kind: 'uvs-cas',
    target: opts.prefix ?? 'refs/heads/main',
  }),
  sqlite: (opts: { table: string; dbPath?: string }): SubstrateDescriptor => ({
    kind: 'sqlite',
    table: opts.table,
    target: opts.dbPath ?? ':memory:',
  }),
  sabRing: (opts: { ringBytes?: number; capacityBytes?: number } = {}): SubstrateDescriptor => ({
    kind: 'sab-ring',
    ringBytes: opts.ringBytes ?? opts.capacityBytes ?? 65536,
  }),
};

export interface ExecutionContext {
  readonly boundary: string;
  readonly display: string;
  readonly lifetime: string;
  readonly transport: string;
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly locality: string;
  readonly persona: string;
}

export interface SectionDefinition<
  TFields extends Record<string, unknown> = Record<string, unknown>,
  TProtocols extends Record<string, ProtocolBinding> = Record<string, ProtocolBinding>,
> {
  readonly id: string;
  readonly version: string;
  readonly kind?: string;
  readonly shape?: Readonly<Record<string, unknown>>;
  readonly description?: string;
  readonly context?: ExecutionContext;
  readonly layout?: string;
  readonly storage?: unknown;
  readonly substrate?: SubstrateDescriptor;
  readonly fields: TFields;
  readonly protocols: TProtocols;
}

export function defineSection<
  TFields extends Record<string, unknown>,
  TProtocols extends Record<string, ProtocolBinding>,
>(spec: SectionDefinition<TFields, TProtocols>): SectionDefinition<TFields, TProtocols> {
  return spec;
}

export interface IntersectionDefinition<TSections extends readonly unknown[] = readonly unknown[]> {
  readonly id: string;
  readonly version: string;
  readonly layout?: string;
  readonly storage?: unknown;
  readonly sections: TSections;
}

export function defineIntersection<TSections extends readonly unknown[]>(
  spec: IntersectionDefinition<TSections>,
): IntersectionDefinition<TSections> {
  return spec;
}
