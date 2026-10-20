"""Recette Web/API/Mongo jetables, réseau extérieur interdit par le lanceur."""
import json, re, sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

base, result_path, fixture_path, executable = sys.argv[1:]
fixture = json.loads(Path(fixture_path).read_text())
out = Path(result_path).parent
out.mkdir(parents=True, exist_ok=True)
expect.set_options(timeout=15000)
checks = []
def checked(label):
    checks.append(label)
    print('OK — ' + label, flush=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=executable or None,
        args=['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'])
    context = browser.new_context(viewport={'width':1280,'height':900}, service_workers='block')
    external, errors, summaries, details, legacy, mutations = [], [], [], [], [], []
    def guard(route):
        if route.request.url.startswith(base + '/') or route.request.url.startswith(('data:', 'blob:')):
            route.continue_()
        else:
            external.append(route.request.url)
            route.abort('blockedbyclient')
    context.route('**/*', guard)
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    def track(route):
        body = json.loads(route.request.post_data or '{}')
        query = body.get('query', '')
        assert 'availableRiders' not in query
        if 'operationsRestaurantSummaries(' in query:
            response = route.fetch()
            payload = response.json()
            assert not payload.get('errors'), payload
            result = payload['data']['operationsRestaurantSummaries']
            assert len(result['items']) <= 20
            assert all(set(item) == {'id','name','open','version'} for item in result['items'])
            assert 'menu' not in query and 'categories' not in query
            assert len(response.body()) < 10000
            summaries.append((body, result))
            route.fulfill(response=response)
        elif 'operationsRestaurant(id:' in query:
            response = route.fetch()
            payload = response.json()
            assert not payload.get('errors'), payload
            details.append((body, payload['data']['operationsRestaurant']))
            route.fulfill(response=response)
        elif re.search(r'\boperationsRestaurants\s*\{', query):
            legacy.append(body)
            route.fallback()
        else:
            if 'setRestaurantOpen(' in query: mutations.append(body)
            route.fallback()
    page.route('**/api/delifast/graphql', track)
    def login(email, password):
        page.goto(base + '/delifast/operations')
        page.get_by_label('Email', exact=True).fill(email)
        page.get_by_label('Mot de passe', exact=True).fill(password)
        page.get_by_role('button', name='Se connecter', exact=True).click()
        expect(page.get_by_role('heading', name='Commandes', exact=True)).to_be_visible()
        page.get_by_role('tab', name='Catalogue', exact=True).click()
        expect(page.get_by_role('heading', name='Plats, catégories et options', exact=True)).to_be_visible()
    login('admin@delifast.local', 'AdminDemo!2026')
    catalogue = page.locator('.df-catalogue')
    select = catalogue.get_by_label('Choisir un restaurant', exact=True)
    expect(select).to_be_enabled()
    def ids():
        return select.locator('option').evaluate_all('(nodes) => nodes.map(n => n.value).filter(Boolean)')
    assert len(ids()) == 20 and not legacy
    pages = [set(ids())]
    next_button = catalogue.get_by_role('button', name='Restaurants suivants', exact=True)
    previous_button = catalogue.get_by_role('button', name='Restaurants précédents', exact=True)
    while next_button.is_enabled():
        assert len(pages) < 5
        next_button.click()
        expect(select).to_be_enabled()
        current = set(ids())
        assert current and len(current) <= 20
        assert set.union(*pages).isdisjoint(current)
        pages.append(current)
    assert len(set.union(*pages)) == 66
    previous_button.click()
    expect(select).to_be_enabled()
    assert set(ids()) == pages[-2]
    checked('66 restaurants parcourus en quatre pages de 20 maximum, sans doublon, retour précédent exact')
    exact = catalogue.get_by_label('ID restaurant exact', exact=True)
    before = len(summaries)
    exact.fill(fixture['restaurantId'])
    assert len(summaries) == before
    catalogue.get_by_role('button', name='Rechercher le restaurant', exact=True).click()
    expect(select).to_be_enabled()
    assert ids() == [fixture['restaurantId']]
    assert summaries[-1][0]['variables']['restaurantId'] == fixture['restaurantId']
    select.select_option(fixture['restaurantId'])
    expect(catalogue.locator('.df-catalogue-status strong')).to_have_text('Restaurant Web 064')
    expect(catalogue.get_by_text('Plat ' + fixture['restaurantId'], exact=True)).to_be_visible()
    expect(catalogue.get_by_text('Archive ' + fixture['restaurantId'], exact=True)).to_be_visible()
    assert all(body['variables']['id'] == row['id'] for body, row in details if row)
    checked('Recherche exacte hors première page et détail opérationnel avec plats archivés, sans catalogue legacy admin')
    catalogue.get_by_role('button', name='Fermer le restaurant', exact=True).click()
    expect(catalogue.get_by_text('Restaurant fermé.', exact=True)).to_be_visible()
    assert len(mutations) == 1
    assert mutations[0]['variables']['id'] == fixture['restaurantId']
    assert mutations[0]['variables']['expectedVersion'] == 0
    page.set_viewport_size({'width':390,'height':844})
    catalogue.scroll_into_view_if_needed()
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    screenshot = out / 'web-catalogue-390.png'
    page.screenshot(path=str(screenshot), full_page=True)
    checked('Mutation unique versionnée persistée et interface 390px sans débordement')
    page.set_viewport_size({'width':1280,'height':900})
    def absent_detail(route):
        body = json.loads(route.request.post_data or '{}')
        if 'operationsRestaurant(id:' in body.get('query',''):
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'data':{'operationsRestaurant':None}}))
        else: route.fallback()
    page.route('**/api/delifast/graphql', absent_detail)
    catalogue.get_by_role('button', name='Actualiser', exact=True).click()
    expect(catalogue.get_by_role('alert')).to_be_visible()
    expect(catalogue.get_by_role('button', name='Créer le plat', exact=True)).to_have_count(0)
    assert len(mutations) == 1
    page.unroute('**/api/delifast/graphql', absent_detail)
    catalogue.get_by_role('button', name='Actualiser', exact=True).click()
    expect(catalogue.locator('.df-catalogue-status strong')).to_have_text('Restaurant Web 064')
    checked('Détail absent bloque toute édition périmée et une actualisation explicite récupère le catalogue')
    catalogue.get_by_role('button', name='Réinitialiser les restaurants', exact=True).click()
    expect(select).to_be_enabled()
    assert set(ids()) == pages[0]
    assert not previous_button.is_enabled()
    exact.fill('restaurant-inconnu')
    catalogue.get_by_role('button', name='Rechercher le restaurant', exact=True).click()
    expect(select.locator('option[value="restaurant-inconnu"]')).to_have_count(0)
    expect(catalogue.locator('.df-catalogue-status')).to_have_count(0)
    checked('Remise à zéro et recherche inconnue sans conserver un détail éditable')
    page.get_by_role('button', name='Se déconnecter', exact=True).click()
    expect(page.get_by_role('heading', name='Connexion équipe', exact=True)).to_be_visible()
    before_summaries, before_details = len(summaries), len(details)
    login('restaurant1@delifast.local', 'RestaurantDemo!2026')
    expect(catalogue.locator('.df-catalogue-status strong')).to_have_text('Restaurant fixture catalogue')
    assert len(legacy) == 1
    assert len(summaries) == before_summaries and len(details) == before_details
    expect(catalogue.get_by_label('Choisir un restaurant', exact=True)).to_have_count(0)
    page.get_by_role('button', name='Se déconnecter', exact=True).click()
    expect(page.get_by_role('heading', name='Connexion équipe', exact=True)).to_be_visible()
    checked('Le rôle restaurant conserve seulement son catalogue serveur autorisé et ne lit aucune API admin')
    assert not external, external
    assert not errors, errors
    checked('Aucun availableRiders, appel externe ou erreur JavaScript ; aucune commande ni paiement')
    Path(result_path).write_text(json.dumps({'restaurantId':fixture['restaurantId'], 'checks':checks, 'pages':len(summaries), 'details':len(details), 'legacyRestaurantCalls':len(legacy), 'mutations':len(mutations), 'screenshots':[str(screenshot)]}, ensure_ascii=False, indent=2))
    browser.close()
