import ModalSurface from './ModalSurface';

export default function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <ModalSurface label="معاينة الوسائط" overlayClassName="fixed inset-0 bg-black/80 grid place-items-center p-4" panelClassName="grid place-items-center" onClose={onClose}>
      <img src={url} alt="" className="max-h-[85vh] max-w-[90vw] object-contain rounded-lg" onClick={(e) => e.stopPropagation()} />
      <button
        data-dialog-initial-focus
        type="button"
        className="absolute top-4 left-4 text-white/80 hover:text-white text-2xl leading-none"
        onClick={onClose}
        aria-label="إغلاق"
      >
        ×
      </button>
    </ModalSurface>
  );
}
