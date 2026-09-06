"""PDFium is process-global and unsafe across threads, even for separate documents."""

from threading import RLock

# Hold this through creation, use and explicit closure of EVERY PDFium object.
pdfium_lock = RLock()
