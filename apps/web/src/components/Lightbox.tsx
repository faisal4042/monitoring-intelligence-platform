export default function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/80 grid place-items-center z-50 p-4" onClick={onClose}>
      <img src={url} alt="" className="max-h-[85vh] max-w-[90vw] object-contain rounded-lg" onClick={(e) => e.stopPropagation()} />
      <button
        type="button"
        className="absolute top-4 left-4 text-white/80 hover:text-white text-2xl leading-none"
        onClick={onClose}
        aria-label="إغلاق"
      >
        ×
      </button>
    </div>
  );
}
