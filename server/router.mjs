export function routeKey(method, pathname) {
  return `${String(method || "").toUpperCase()} ${pathname}`;
}

export function createApiRouter({ exact = [], dynamic = [] } = {}) {
  const exactRoutes = new Map(
    exact.map(([method, pathname, handler]) => [routeKey(method, pathname), handler]),
  );
  const dynamicRoutes = dynamic.map((route) => ({
    ...route,
    methods: route.methods instanceof Set ? route.methods : new Set(route.methods),
  }));

  return async function handleApi(request, response, url) {
    const exactHandler = exactRoutes.get(routeKey(request.method, url.pathname));
    if (exactHandler) {
      await exactHandler(request, response, url);
      return true;
    }

    const dynamicHandler = dynamicRoutes.find((route) => (
      route.methods.has(request.method)
      && route.matches(url)
    ));
    if (dynamicHandler) {
      await dynamicHandler.handler(request, response, url);
      return true;
    }

    return false;
  };
}
