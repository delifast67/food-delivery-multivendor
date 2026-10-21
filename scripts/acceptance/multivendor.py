"""Test uniquement : lancé par delifast-acceptance.mjs dans un réseau privé."""
import json
import re
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

base, mailbox, result, executable = sys.argv[1:]
expect.set_options(timeout=15000)
for attempt in range(120):
    try:
        with urlopen(base + '/delifast', timeout=2) as response:
            if response.status == 200:
                break
    except (OSError, TimeoutError):
        time.sleep(0.5)
else:
    raise AssertionError('Le web jetable ne démarre pas')


def gql(page, query, variables=None, token=None):
    # Vraie requête au proxy Next puis à l'API, aucun routage GraphQL mocké.
    return page.evaluate('''async ({query, variables, token}) => {
      const response = await fetch('/api/delifast/graphql', {
        method: 'POST', headers: {'content-type': 'application/json',
          ...(token ? {authorization: `Bearer ${token}`} : {})},
        body: JSON.stringify({query, variables})});
      return response.json();
    }''', dict(query=query, variables=variables or {}, token=token))


def success(page, query, variables=None, token=None):
    body = gql(page, query, variables, token)
    assert not body.get('errors'), body.get('errors')
    return body['data']


def token(page):
    return page.evaluate("sessionStorage.getItem('delifast-staff-token')")


def open_order(page, order):
    page.get_by_role('button', name=re.compile('#' + re.escape(order))).click()
    expect(page.get_by_text('Adresse de livraison', exact=True)).to_be_visible()


def move(page, label):
    page.get_by_role('button', name=f'Passer à « {label} »', exact=True).click()
    expect(page.locator('.df-order-title .df-status')).to_have_text(label)


@contextmanager
def browser_session(p):
    browser = p.chromium.launch(
        headless=True,
        **({'executable_path': executable} if executable else {}),
        args=['--no-sandbox', '--disable-background-networking', '--disable-component-update',
              '--disable-default-apps', '--disable-sync', '--no-first-run'],
    )
    try:
        yield browser
    finally:
        browser.close()


with sync_playwright() as p, browser_session(p) as browser:
    forbidden, errors, contexts = [], [], []

    def new_page():
        context = browser.new_context(service_workers='block')
        contexts.append(context)

        def guard(route):
            url = route.request.url
            if urlsplit(url).scheme in ('data', 'blob') or url.startswith(base + '/'):
                route.continue_()
            else:
                forbidden.append(url)
                route.abort('blockedbyclient')

        context.route('**/*', guard)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        return page

    def staff(user):
        page = new_page()
        page.goto(base + '/delifast/operations')
        page.get_by_label('Email', exact=True).fill(user + '@test.local')
        page.get_by_label('Mot de passe', exact=True).fill('Fixture!2026')
        page.get_by_role('button', name='Se connecter', exact=True).click()
        expect(page.get_by_role('heading', name='Commandes', exact=True)).to_be_visible()
        return page

    clients = [new_page(), new_page()]
    orders, tracking = [], []
    for index, page in enumerate(clients):
        page.goto(base + '/delifast')
        expect(page.get_by_role('button', name=f'Ajouter Plat r{index + 1}', exact=True)).to_be_visible()
        if index == 0:
            page.get_by_role('button', name='Se connecter', exact=True).click()
            page.locator('#customer-phone').fill('+22670123456')
            with page.expect_response(lambda response: response.url.endswith('/api/delifast/graphql')
                                      and 'requestCustomerOtp' in (response.request.post_data or '')) as challenge_response:
                page.get_by_role('button', name='Demander une connexion', exact=True).click()
            challenge = challenge_response.value.json()['data']['requestCustomerOtp']
            assert set(challenge) == {'challengeId', 'expiresIn', 'retryAfter'}
            otp = json.loads(Path(mailbox).read_text())
            assert otp['phone'] == '+22670123456'
            assert re.fullmatch(r'\d{6}', otp['code'])
            # Le serveur génère le code : le test le reçoit via un fichier privé,
            # jamais via un endpoint de test, une constante UX ou une réponse API.
            assert otp['code'] not in json.dumps(challenge)
            assert otp['code'] not in page.locator('body').inner_text()
            wrong = ('1' if otp['code'][0] != '1' else '2') + otp['code'][1:]
            page.get_by_label('Code', exact=True).fill(wrong)
            page.get_by_role('button', name='Vérifier', exact=True).click()
            expect(page.get_by_role('alert')).to_be_visible()
            expect(page.get_by_role('button', name='Mon compte', exact=True)).to_have_count(0)
            page.get_by_label('Code', exact=True).fill(otp['code'])
            page.get_by_role('button', name='Vérifier', exact=True).click()
            expect(page.get_by_role('button', name='Mon compte', exact=True)).to_be_visible()
            page.get_by_role('button', name='Mon compte', exact=True).click()
        page.get_by_role('button', name=f'Ajouter Plat r{index + 1}', exact=True).click()
        page.get_by_label('Nom du destinataire', exact=True).fill(f'Client fictif {index + 1}')
        page.get_by_label('Téléphone', exact=True).fill('+22670123456')
        page.get_by_label('Quartier', exact=True).fill('Fixture')
        page.get_by_label('Repère', exact=True).fill('Ne pas livrer — test automatique')
        page.get_by_role('button', name='Enregistrer la commande', exact=True).click()
        expect(page.get_by_role('heading', name='Votre commande est en attente de paiement.', exact=True)).to_be_visible()
        saved = page.evaluate("JSON.parse(localStorage.getItem('delifast-order-attempt'))")
        orders.append(saved['order']['id'])
        tracking.append(saved['order']['accessToken'])
        print(f'OK — commande client r{index + 1} enregistrée via UI', flush=True)

    admin = staff('admin')
    rider = staff('rider')
    other_rider = staff('other-rider')
    for page in [rider, other_rider]:
        expect(page.get_by_text('Aucune commande accessible pour votre rôle.', exact=True)).to_be_visible()
    for order in orders:
        card = admin.locator('article').filter(has=admin.get_by_text('#' + order, exact=True))
        card.get_by_role('button', name=re.compile('#' + re.escape(order))).click()
        card.get_by_role('button', name='Simuler le paiement démo', exact=True).click()
        expect(card.locator('.df-status')).to_have_text('Confirmée')

    restaurants = [staff('restaurant1'), staff('restaurant2')]
    query = '{operationsOrders{id restaurantId accessToken deliveryAddress{recipientName} history{status}}}'
    for index, page in enumerate(restaurants):
        own, foreign = orders[index], orders[1 - index]
        expect(page.locator('.df-ops-card')).to_have_count(1)
        expect(page.get_by_text('#' + own, exact=True)).to_be_visible()
        expect(page.get_by_text('#' + foreign, exact=True)).to_have_count(0)
        data = success(page, query, token=token(page))['operationsOrders']
        assert [entry['id'] for entry in data] == [own]
        assert data[0]['accessToken'] == ''
        denied = gql(page, 'mutation($id:ID!){transitionOrder(orderId:$id,status:"ACCEPTED",expectedStatus:"CONFIRMED"){id}}', {'id': foreign}, token(page))
        assert denied['errors'][0]['extensions']['code'] == 'ORDER_NOT_FOUND'
        # Même un jeton staff valide ne remplace pas le jeton de suivi client.
        hidden = success(page, 'query($id:ID!){order(id:$id,accessToken:"incorrect"){id deliveryAddress{recipientName}}}', {'id': foreign}, token(page))
        assert hidden['order'] is None
        page.reload()
        expect(page.locator('.df-ops-card')).to_have_count(1)
        expect(page.get_by_text('#' + foreign, exact=True)).to_have_count(0)
        open_order(page, own)
        for label in ['Acceptée', 'En préparation', 'Prête']:
            move(page, label)
        print(f'OK — restaurant r{index + 1} isolé, acceptation et préparation via UI', flush=True)

    admin.reload()
    for order in orders:
        card = admin.locator('article').filter(has=admin.get_by_text('#' + order, exact=True))
        card.get_by_role('button', name=re.compile('#' + re.escape(order))).click()
        card.get_by_label('Assigner un livreur', exact=True).select_option('rider')
        expect(card.get_by_label('Assigner un livreur', exact=True)).to_be_disabled()
        expect(card.get_by_label('Assigner un livreur', exact=True)).to_have_value('rider')
    other_rider.reload()
    expect(other_rider.get_by_text('Aucune commande accessible pour votre rôle.', exact=True)).to_be_visible()
    assert success(other_rider, query, token=token(other_rider))['operationsOrders'] == []
    rider.reload()
    expect(rider.locator('.df-ops-card')).to_have_count(2)
    for order in orders:
        card = rider.locator('article').filter(has=rider.get_by_text('#' + order, exact=True))
        card.get_by_role('button', name=re.compile('#' + re.escape(order))).click()
        for label in ['Récupérée', 'Livrée']:
            card.get_by_role('button', name=f'Passer à « {label} »', exact=True).click()
            expect(card.locator('.df-status')).to_have_text(label)
    print('OK — affectation admin et livraison via UI ; autre livreur sans accès', flush=True)

    for index, page in enumerate(clients):
        # Les données sauvegardées ne contiennent pas le nouveau statut : il doit
        # être relu depuis MongoDB après un vrai rechargement du document.
        page.reload()
        expect(page.get_by_role('heading', name='Votre commande a été livrée (démo).', exact=True)).to_be_visible()
        history = page.get_by_label('Historique de la commande', exact=True)
        expect(history.locator('div > span')).to_have_text([
            'Paiement en attente', 'Confirmée', 'Acceptée', 'En préparation', 'Prête', 'Récupérée', 'Livrée'])
        expect(page.get_by_text(orders[index], exact=True)).to_be_visible()
        expect(page.get_by_text(orders[1 - index], exact=True)).to_have_count(0)
        denied = success(page, 'query($id:ID!,$key:String!){order(id:$id,accessToken:$key){id}}', {'id': orders[1 - index], 'key': tracking[index]})
        assert denied['order'] is None
        print(f'OK — suivi client r{index + 1} relu après rechargement, historique exact et jeton isolé', flush=True)
    assert not forbidden, f'Requêtes hors origine interdites : {forbidden}'
    assert not errors, f'Erreurs JavaScript : {errors}'
    Path(result).write_text(json.dumps({'orders': orders}))
