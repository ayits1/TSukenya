import { useState } from 'react';
import { compareThreeWay, resolveThreeWay, type MergeChoices } from '../merge/threeWay';
import { ConflictComparison } from '../ui/ConflictComparison';
import { nativeFields, type NativeDraft, type NativeField } from './fields';

export type NativeConflictProps = {
  base: NativeDraft;
  mine: NativeDraft;
  server: NativeDraft;
  fields: NativeField[];
  onApply: (draft: NativeDraft) => void;
  onCancel: () => void;
  title?: string;
};

/** No HTTP or save action: resolving a comparison only returns a local draft. */
export function NativeConflict({
  base,
  mine,
  server,
  fields,
  onApply,
  onCancel,
  title,
}: NativeConflictProps) {
  const [choices, setChoices] = useState<MergeChoices>({});
  const descriptors = nativeFields(fields);
  return (
    <ConflictComparison
      {...(title ? { title } : {})}
      rows={compareThreeWay(base, mine, server, descriptors)}
      choices={choices}
      onChoice={(id, choice) => setChoices((previous) => ({ ...previous, [id]: choice }))}
      onCancel={onCancel}
      onApply={() => {
        const draft = resolveThreeWay(base, mine, server, descriptors, choices);
        if (draft) onApply(draft);
      }}
    />
  );
}
