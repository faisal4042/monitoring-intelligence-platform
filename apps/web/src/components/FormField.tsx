import { Children, isValidElement, createContext, useContext, useId, useState, forwardRef, type ComponentPropsWithoutRef, type ReactElement, type ReactNode } from 'react';

type FieldContext = { id: string; describedBy?: string; invalid: boolean; required?: boolean; disabled?: boolean };
const Context = createContext<FieldContext | null>(null);
export function FormField({ id: suppliedId, label, description, error, required, disabled, children,
  className, labelClassName = 'block text-sm mb-1', descriptionClassName = 'text-xs muted mb-3' }: {
  id?: string; label: ReactNode; description?: ReactNode; error?: ReactNode; required?: boolean; disabled?: boolean;
  children: ReactNode; className?: string; labelClassName?: string; descriptionClassName?: string;
}) {
  const generatedId = useId();
  const control = Children.toArray(children).find(isValidElement) as ReactElement<{ id?: string; required?: boolean; disabled?: boolean }> | undefined;
  const id = suppliedId ?? control?.props.id ?? `field-${generatedId}`;
  const fieldRequired = required ?? control?.props.required;
  const fieldDisabled = disabled ?? control?.props.disabled;
  const [nativeError, setNativeError] = useState<string | null>(null);
  const shownError = error || nativeError;
  const describedBy = [description ? `${id}-description` : '', shownError ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  return <Context.Provider value={{ id, describedBy, invalid: Boolean(shownError), required: fieldRequired, disabled: fieldDisabled }}>
    <div className={className} onInvalidCapture={event => {
      const control = event.target as HTMLInputElement;
      setNativeError(control.validity?.valueMissing ? 'هذا الحقل مطلوب.' : 'تحقق من قيمة الحقل وصيغتها.');
    }} onChangeCapture={event => {
      if ((event.target as HTMLInputElement).validity?.valid) setNativeError(null);
    }}>
      <label htmlFor={id} className={labelClassName}>{label}{fieldRequired && <span aria-hidden="true"> *</span>}</label>
      {children}
      {description && <p id={`${id}-description`} className={descriptionClassName}>{description}</p>}
      {shownError && <p id={`${id}-error`} className="text-xs text-red-600 dark:text-red-400 mt-1" role="alert">{shownError}</p>}
    </div>
  </Context.Provider>;
}
function useFieldProps(props: { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling'; required?: boolean; disabled?: boolean }) {
  const field = useContext(Context);
  return { id: field?.id ?? props.id, required: field?.required ?? props.required, disabled: field?.disabled ?? props.disabled,
    'aria-invalid': props['aria-invalid'] ?? (field?.invalid || undefined),
    'aria-describedby': [props['aria-describedby'], field?.describedBy].filter(Boolean).join(' ') || undefined };
}
export const FieldInput = forwardRef<HTMLInputElement, ComponentPropsWithoutRef<'input'>>((props, ref) => {
  const a11y = useFieldProps(props); return <input {...props} {...a11y} {...(props.autoFocus ? { 'data-dialog-initial-focus': true } : {})} ref={ref} />;
});
export const FieldSelect = forwardRef<HTMLSelectElement, ComponentPropsWithoutRef<'select'>>((props, ref) => {
  const a11y = useFieldProps(props); return <select {...props} {...a11y} {...(props.autoFocus ? { 'data-dialog-initial-focus': true } : {})} ref={ref} />;
});
export const FieldTextarea = forwardRef<HTMLTextAreaElement, ComponentPropsWithoutRef<'textarea'>>((props, ref) => {
  const a11y = useFieldProps(props); return <textarea {...props} {...a11y} {...(props.autoFocus ? { 'data-dialog-initial-focus': true } : {})} ref={ref} />;
});
