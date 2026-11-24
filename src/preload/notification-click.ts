// Runs at preload time in the page's world. The callback stays in this closure;
// no IPC object, window binding or page-callable desktop API is exposed.
export function installNotificationClicks(clicked: () => void): void {
  const NativeNotification = window.Notification;
  const addListener = EventTarget.prototype.addEventListener;
  const construct = Reflect.construct, apply = Reflect.apply;
  window.Notification = new Proxy(NativeNotification, {
    construct(target, args, newTarget) {
      const notification = construct(target, args, newTarget) as Notification;
      // Register before WhatsApp sets onclick, leaving its chat navigation and
      // all native notification lifecycle/permission behavior intact.
      apply(addListener, notification, ['click', (event: Event) => {
        if (event.isTrusted) clicked();
      }]);
      return notification;
    }
  });
}
