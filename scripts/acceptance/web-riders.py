"""Recette réelle Web/API/Mongo jetables, sans fournisseur externe."""
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
    external, errors, summaries, details, assignments, queries = [], [], [], [], [], []
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
        queries.append(query)
        assert 'availableRiders' not in query, 'Aucun appel legacy Web autorisé'
        if 'operationsRiderSummaries(' in query:
            response = route.fetch()
            payload = response.json()
            assert not payload.get('errors'), payload
            result = payload['data']['operationsRiderSummaries']
            assert len(result['items']) <= 20
            assert all(set(item) == {'id','name'} for item in result['items'])
            assert len(response.body()) < 10000
            summaries.append((body, result))
            route.fulfill(response=response)
        elif 'operationsRider(id:' in query:
            response = route.fetch()
            payload = response.json()
            assert not payload.get('errors'), payload
            item = payload['data']['operationsRider']
            assert item is None or set(item) == {'id','name','role','restaurantId'}
            details.append((body, item))
            route.fulfill(response=response)
        elif 'assignRider(' in query:
            assignments.append(body)
            route.fallback()
        else:
            route.fallback()
    page.route('**/api/delifast/graphql', track)
    def login(email, password):
        page.goto(base + '/delifast/operations')
        page.get_by_label('Email', exact=True).fill(email)
        page.get_by_label('Mot de passe', exact=True).fill(password)
        page.get_by_role('button', name='Se connecter', exact=True).click()
        expect(page.get_by_role('heading', name='Commandes', exact=True)).to_be_visible()
        expect(page.get_by_role('button', name='Actualiser', exact=True)).to_be_enabled()
    def open_order():
        page.get_by_role('button', name=re.compile(re.escape(fixture['orderId']))).click()
    login('admin@delifast.local', 'AdminDemo!2026')
    assert not summaries and not details
    page.get_by_role('button', name='Actualiser', exact=True).click()
    expect(page.get_by_role('button', name='Actualiser', exact=True)).to_be_enabled()
    assert not summaries and not details
    checked('Aucun catalogue à la connexion ni au rafraîchissement admin')
    open_order()
    picker = page.locator('.df-assign')
    select = picker.get_by_label('Assigner un livreur', exact=True)
    expect(select).to_be_enabled()
    expect(select.locator('option')).to_have_count(21)
    assert len(summaries) == 1 and not details
    def ids():
        return select.locator('option').evaluate_all('(nodes) => nodes.map(n => n.value).filter(Boolean)')
    pages = [set(ids())]
    next_button = picker.get_by_role('button', name='Livreurs suivants', exact=True)
    previous_button = picker.get_by_role('button', name='Livreurs précédents', exact=True)
    while next_button.is_enabled():
        assert len(pages) < 5
        next_button.click()
        expect(select).to_be_enabled()
        current = set(ids())
        assert current and len(current) <= 20
        assert set.union(*pages).isdisjoint(current)
        pages.append(current)
    seen = set.union(*pages)
    assert len(seen) == 66
    assert 'z-web-rider-inactive' not in seen and 'z-web-not-rider' not in seen
    previous_button.click()
    expect(select).to_be_enabled()
    assert set(ids()) == pages[-2]
    checked('66 livreurs actifs parcourus en quatre pages de 20 maximum, sans doublon, retour précédent exact')
    exact = picker.get_by_label('ID livreur exact', exact=True)
    before = len(summaries)
    exact.fill('z-web-rider-064')
    assert len(summaries) == before
    picker.get_by_role('button', name='Rechercher le livreur', exact=True).click()
    expect(select).to_be_enabled()
    expect(select.locator('option')).to_have_count(2)
    assert ids() == ['z-web-rider-064']
    assert summaries[-1][0]['variables']['riderId'] == 'z-web-rider-064'
    picker.get_by_role('button', name='Réinitialiser les livreurs', exact=True).click()
    expect(select).to_be_enabled()
    assert set(ids()) == pages[0]
    assert not previous_button.is_enabled()
    exact.fill('z-web-rider-inactive')
    picker.get_by_role('button', name='Rechercher le livreur', exact=True).click()
    expect(picker.get_by_text('Aucun livreur actif trouvé.', exact=True)).to_be_visible()
    assert ids() == []
    checked('Recherche exacte hors première page, remise à zéro, et exclusion d’un livreur inactif')
    exact.fill('z-web-rider-064')
    picker.get_by_role('button', name='Rechercher le livreur', exact=True).click()
    expect(select).to_be_enabled()
    expect(select.locator('option')).to_have_count(2)
    assert not details and not assignments
    # Une relecture invalide ne doit pas émettre de mutation.
    def invalid_detail(route):
        body = json.loads(route.request.post_data or '{}')
        if 'operationsRider(id:' in body.get('query',''):
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'data':{'operationsRider':None}}))
        else:
            route.fallback()
    page.route('**/api/delifast/graphql', invalid_detail)
    select.select_option('z-web-rider-064')
    expect(picker.get_by_role('alert')).to_contain_text('Livreur indisponible')
    assert not assignments
    page.unroute('**/api/delifast/graphql', invalid_detail)
    checked('Un détail absent bloque l’affectation sans mutation')
    before_pages = len(summaries)
    select.select_option('z-web-rider-064')
    expect(select).to_have_value('z-web-rider-064')
    expect(select).to_be_disabled()
    expect(picker.get_by_text(re.compile('Affectation définitive'))).to_be_visible()
    assert len(assignments) == 1 and len(details) == 1
    assert details[0][1]['role'] == 'RIDER'
    assert len(summaries) == before_pages
    page.set_viewport_size({'width':390,'height':844})
    picker.scroll_into_view_if_needed()
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    page.screenshot(path=str(out / 'web-rider-assigned-390.png'), full_page=True)
    checked('Détail minimal vérifié avant une affectation unique et définitive ; 390px sans débordement')
    page.get_by_role('button', name='Se déconnecter', exact=True).click()
    expect(page.get_by_role('heading', name='Connexion équipe', exact=True)).to_be_visible()
    assert page.evaluate('sessionStorage.getItem("delifast-staff-token")') is None
    before = len(summaries)
    login('restaurant1@delifast.local', 'RestaurantDemo!2026')
    open_order()
    assert picker.count() == 0 and len(summaries) == before
    page.get_by_role('button', name='Se déconnecter', exact=True).click()
    expect(page.get_by_role('heading', name='Connexion équipe', exact=True)).to_be_visible()
    checked('Déconnexion purge la session ; le restaurant ne lit jamais le catalogue livreurs')
    assert not external, external
    assert not errors, errors
    checked('Aucun availableRiders, appel externe ou erreur JavaScript')
    Path(result_path).write_text(json.dumps({'orderId':fixture['orderId'], 'riderId':'z-web-rider-064', 'checks':checks, 'pages':len(summaries), 'details':len(details), 'screenshots':[str(out / 'web-rider-assigned-390.png')]}, ensure_ascii=False, indent=2))
    browser.close()
