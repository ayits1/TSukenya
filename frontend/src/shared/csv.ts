// The classic portal loads this same source before its scripts. Vite includes it in the bundle.
import '../../../app/csv.js';

export type CsvColumn = { label: string; kind: 'text' | 'number' };
export type CsvValue = string | number | boolean | null | undefined;
type CsvApi = {
  serialize(
    columns: readonly CsvColumn[],
    rows: readonly (readonly CsvValue[])[],
    options?: { delimiter?: ';' | ','; bom?: boolean; reversible?: boolean },
  ): string;
  parse(source: string): string[][];
  decode(rows: string[][]): string[][];
};
declare const TSukenyaCsv: CsvApi;
export const csv = TSukenyaCsv;
