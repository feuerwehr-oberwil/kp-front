"""PDFium is process-global and unsafe across threads, even for separate documents."""

# **PDFium calls share one process-wide lock.** Hold `app/pdfium_lock.py`'s lock through object
# creation, rendering and explicit closure, including print-page reversal. Run this synchronous
# work off the request event loop; separate PDF documents are not thread-safe either.

from threading import RLock

# Hold this through creation, use and explicit closure of EVERY PDFium object.
pdfium_lock = RLock()
